import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SemanticMemoryResponse } from "@ardurbot/adapter-kit";
import { isLocalMcpHost } from "@ardurbot/contracts";
import { Agent } from "undici";
import {
  createAddressCheckedLookup,
  isCloudMetadataAddress,
  isPrivateAddress,
} from "../network-address.js";
import type { RemoteTransportDependencies } from "../remote-mcp.js";
import { createSafeRemoteFetch } from "../remote-mcp.js";
import {
  classifySerenityEndpointTrust,
  parseSerenityEndpoint,
  serenityEndpointRequiresDeploymentOwner,
} from "../serenity-client.js";
import { MemoryProviderDeploymentOwnerRequiredError } from "../serenity-memory-provider.js";
import { dispatcherFetch } from "../undici-fetch.js";

export interface SemanticHttpConnection {
  baseUrl: string;
  endpointTrust?: string;
}
export interface SemanticHttpDependencies extends RemoteTransportDependencies {
  now?: () => number;
}
export function semanticBaseUrl(baseUrl: string, loopbackHttpOnly = false): string {
  const url = parseSerenityEndpoint(baseUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isCloudMetadataAddress(host)) throw new Error("This memory endpoint is blocked.");
  if (url.protocol === "http:" && loopbackHttpOnly && !isLocalMcpHost(host))
    throw new Error("Use HTTPS for memory services outside loopback.");
  if (url.protocol === "http:" && isIP(host) && !isPrivateAddress(host))
    throw new Error("Use HTTPS for public memory services.");
  return url.href.replace(/\/+$/, "");
}
export function semanticRequiresDeploymentOwner(settings: Record<string, string>) {
  return (
    settings.endpointTrust === "private" ||
    (!!settings.baseUrl && serenityEndpointRequiresDeploymentOwner(settings.baseUrl))
  );
}
export async function classifySemanticSettings(
  settings: Record<string, string>,
  network: SemanticHttpDependencies = {},
) {
  const baseUrl = semanticBaseUrl(settings.baseUrl ?? "");
  const endpointTrust = await classifySerenityEndpointTrust(baseUrl, network.resolveHostname);
  return { ...settings, baseUrl, endpointTrust };
}
export async function authorizeSemanticConnection(
  settings: Record<string, string>,
  allowPrivateEndpoint: boolean | undefined,
  network: SemanticHttpDependencies = {},
) {
  const classified = await classifySemanticSettings(settings, network);
  if (classified.endpointTrust === "private" && allowPrivateEndpoint !== true)
    throw new MemoryProviderDeploymentOwnerRequiredError();
  return classified;
}
export class SemanticHttpError extends Error {
  constructor(
    readonly pending = false,
    readonly retryAfterMs?: number,
  ) {
    super(
      pending
        ? "Memory indexing is pending. Retry."
        : "The memory service request failed. Check the connection and retry.",
    );
  }
}
export function semanticFailure(error: unknown): SemanticMemoryResponse<never> {
  return error instanceof SemanticHttpError
    ? { ok: false, error: error.message, pending: error.pending, retryAfterMs: error.retryAfterMs }
    : { ok: false, error: "The memory service request failed. Check the connection and retry." };
}
export const indexingPending = (receipt?: string): SemanticMemoryResponse<never> => ({
  ok: false,
  pending: true,
  error: "Saved locally. Indexing pending.",
  receipt,
  retryAfterMs: 5_000,
});
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function rows(value: unknown, key: string): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : record(value)[key];
  if (!Array.isArray(items)) throw new SemanticHttpError();
  return items.map(record);
}

/** Each request rechecks DNS and pins the answer; redirects never carry credentials onward. */
export class SemanticHttpClient {
  constructor(
    readonly connection: SemanticHttpConnection,
    private readonly headers: Record<string, string>,
    private readonly network: SemanticHttpDependencies = {},
  ) {}
  async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const base = semanticBaseUrl(this.connection.baseUrl);
    const url = new URL(`${base}${path}`);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const isPrivate =
      this.connection.endpointTrust === "private" || serenityEndpointRequiresDeploymentOwner(base);
    let close: (() => Promise<void>) | undefined;
    try {
      let send = this.network.fetch ?? globalThis.fetch;
      let dispatcher: Agent | undefined;
      if (isPrivate) {
        const resolve =
          this.network.resolveHostname ??
          (async (name: string) => lookup(name, { all: true, verbatim: true }));
        const addresses = isIP(host)
          ? [{ address: host, family: isIP(host) }]
          : await resolve(host);
        if (
          !addresses.length ||
          addresses.some((a) => isCloudMetadataAddress(a.address) || !isPrivateAddress(a.address))
        )
          throw new SemanticHttpError();
        dispatcher = new Agent({
          connect: {
            lookup: createAddressCheckedLookup(
              async () => addresses,
              () => undefined,
            ),
          },
        });
        close = () => dispatcher!.close();
        send = this.network.fetch ?? dispatcherFetch;
      } else {
        const safe = createSafeRemoteFetch(this.network.fetch, this.network.resolveHostname);
        send = safe;
        close = () => safe.close();
      }
      const response = await send(url, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...this.headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get("retry-after");
        const now = this.network.now?.() ?? Date.now();
        const delay =
          retry && /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : retry
              ? Date.parse(retry) - now
              : 5000;
        throw new SemanticHttpError(
          true,
          Number.isFinite(delay) ? Math.max(1000, Math.min(delay, 86_400_000)) : 5000,
        );
      }
      if (method === "DELETE" && response.status === 404) return {};
      if (!response.ok) throw new SemanticHttpError();
      if (response.status === 204) return {};
      const text = await response.text();
      if (text.length > 4_000_000) throw new SemanticHttpError();
      return text ? JSON.parse(text) : {};
    } catch (error) {
      if (error instanceof SemanticHttpError) throw error;
      // Never propagate upstream bodies, fetch exceptions, or tokens into jobs/logs.
      throw new SemanticHttpError(true, 5000);
    } finally {
      await close?.().catch(() => undefined);
    }
  }
}
