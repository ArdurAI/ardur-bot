import { timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { HostProviderGrant } from "@ardurbot/contracts/host-bridge";
import { HostProviderOpenSchema, HostProviderReadSchema } from "@ardurbot/contracts/host-bridge";

import type { ChildOutputLogger } from "../child-output.js";
import { childProcessLogger, redactChildText } from "../child-output.js";
import type { HermesProviderFailure } from "./hermes-provider-failure.js";
import { hermesProviderFailure } from "./hermes-provider-failure.js";

type ProviderMethod = "provider.open" | "provider.read" | "provider.cancel";
const REQUEST_BYTES = 256 * 1024;
const RESPONSE_BYTES = 4 * 1024 * 1024;
const DISCONNECTED = Symbol("provider client disconnected");

function waitForDrain(res: ServerResponse): Promise<void> {
  if (res.destroyed || res.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      res.off("drain", finish);
      res.off("close", finish);
      res.off("error", finish);
      resolve();
    };
    res.once("drain", finish);
    res.once("close", finish);
    res.once("error", finish);
    if (res.destroyed || res.writableEnded) finish();
  });
}

/** A one-turn HTTP facade. All provider policy and credentials remain with the worker. */
export async function startHermesProviderRelay(
  grant: HostProviderGrant,
  callback: (method: ProviderMethod, args: unknown[]) => Promise<unknown>,
  onFailure?: (failure: HermesProviderFailure) => void,
  logger: ChildOutputLogger = childProcessLogger(),
) {
  let closed = false;
  let busy = false;
  let active: { destroy(): void } | undefined;
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const expected = Buffer.from(grant.token);
    if (
      closed ||
      Date.now() >= grant.expiresAt ||
      req.method !== "POST" ||
      req.url !== "/v1/chat/completions" ||
      busy ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.writeHead(403).end();
      return;
    }
    busy = true;
    active = res;
    let completed = false;
    let cancelled = false;
    let disconnected = false;
    let signalDisconnect!: () => void;
    const clientDisconnected = new Promise<typeof DISCONNECTED>((resolve) => {
      signalDisconnect = () => resolve(DISCONNECTED);
    });
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      void Promise.resolve()
        .then(() => callback("provider.cancel", []))
        .catch(() => undefined);
    };
    const disconnect = () => {
      if (disconnected || completed) return;
      disconnected = true;
      signalDisconnect();
      cancel();
    };
    req.on("aborted", disconnect);
    req.on("close", () => {
      if (!req.complete) disconnect();
    });
    res.on("close", () => {
      if (!res.writableEnded) disconnect();
    });
    res.on("error", disconnect);
    const requireClient = () => {
      if (disconnected || res.destroyed || res.writableEnded)
        throw new Error("Provider client disconnected.");
    };
    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > REQUEST_BYTES) throw new Error("Provider request exceeded the limit.");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requireClient();
      const openResult = await Promise.race([
        callback("provider.open", [body]),
        clientDisconnected,
      ]);
      if (openResult === DISCONNECTED) throw new Error("Provider client disconnected.");
      const opened = HostProviderOpenSchema.parse(openResult);
      let total = 0;
      let seq = 0;
      requireClient();
      res.writeHead(opened.status, { "content-type": opened.contentType });
      while (!closed && Date.now() < grant.expiresAt) {
        requireClient();
        const readResult = await Promise.race([
          callback("provider.read", [seq]),
          clientDisconnected,
        ]);
        if (readResult === DISCONNECTED) throw new Error("Provider client disconnected.");
        const next = HostProviderReadSchema.parse(readResult);
        if (next.seq !== seq++) throw new Error("Provider response sequence changed.");
        const content = Buffer.from(next.chunk, "base64");
        total += content.length;
        if (total > RESPONSE_BYTES) throw new Error("Provider response exceeded the limit.");
        requireClient();
        if (content.length && !res.write(content)) await waitForDrain(res);
        requireClient();
        if (next.done) {
          completed = true;
          res.end();
          return;
        }
      }
      throw new Error("Provider grant expired.");
    } catch (error) {
      const failure = hermesProviderFailure(error);
      // Project the exception to fixed safe facts, never its text, cause or data.
      const safeError = new Error(redactChildText(JSON.stringify(failure), [grant.token]));
      safeError.stack = undefined;
      logger.error?.("Hermes provider request failed", safeError);
      onFailure?.(failure);
      if (!res.destroyed && !res.writableEnded) {
        if (!res.headersSent) res.writeHead(502).end("Provider request failed.");
        else res.destroy();
      }
    } finally {
      busy = false;
      active = undefined;
      if (!completed) cancel();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback relay did not bind.");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close() {
      if (closed) return;
      closed = true;
      active?.destroy();
      server.close();
      server.closeAllConnections();
    },
  };
}
