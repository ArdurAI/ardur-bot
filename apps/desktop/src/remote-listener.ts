import { createHash, X509Certificate } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { networkInterfaces } from "node:os";
import { isDeviceApiPath } from "@ardurbot/contracts/device-paths";

import { isLoopbackHost } from "./setup-config.js";

export const DEVICE_LISTENER_PORT = 43119;
export function privateDeviceAddress(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((v) => !Number.isInteger(v) || v < 0 || v > 255))
    return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127)
  );
}
export function deviceConnectionHints(port = DEVICE_LISTENER_PORT): string[] {
  return [
    ...new Set(
      Object.values(networkInterfaces()).flatMap((addresses) =>
        (addresses ?? [])
          .filter((a) => !a.internal && a.family === "IPv4" && privateDeviceAddress(a.address))
          .map((a) => `https://${a.address}:${port}`),
      ),
    ),
  ].slice(0, 8);
}
export function allowedDeviceRequest(
  method: string | undefined,
  path: string | undefined,
): boolean {
  return method === "POST" && typeof path === "string" && isDeviceApiPath(path);
}
/** No cookies, authorization headers, redirects, websocket upgrades, arbitrary targets or RPC forwarding. */
export function deviceProxy(target: string, request: typeof fetch = fetch) {
  const origin = new URL(target);
  if (
    !isLoopbackHost(origin.hostname) ||
    origin.origin !== target ||
    !["http:", "https:"].includes(origin.protocol)
  )
    throw new Error("A local home is required.");
  return async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    outgoing.setHeader("cache-control", "no-store");
    if (!allowedDeviceRequest(incoming.method, incoming.url)) {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    try {
      const parts: Buffer[] = [];
      let length = 0;
      for await (const part of incoming) {
        length += part.length;
        if (length > 128 * 1024) {
          outgoing.writeHead(413);
          outgoing.end();
          incoming.destroy();
          return;
        }
        parts.push(Buffer.from(part));
      }
      const response = await request(`${target}${incoming.url}`, {
        method: "POST",
        body: Buffer.concat(parts),
        headers: { "content-type": "application/json" },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > 16 * 1024 * 1024) {
              await reader.cancel();
              throw new Error("Response too large.");
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const body = Buffer.concat(chunks);
      outgoing.writeHead(response.status, { "content-type": "application/json" });
      outgoing.end(body);
    } catch {
      outgoing.writeHead(502, { "content-type": "application/json" });
      outgoing.end(
        JSON.stringify({ message: "Home unreachable — check that Ardur Bot is running" }),
      );
    }
  };
}
export class RemoteListener {
  private servers: ReturnType<typeof createServer>[] = [];
  private hints: string[] = [];
  state() {
    return { enabled: this.servers.length > 0, hints: [...this.hints] };
  }
  async stop() {
    const servers = this.servers;
    this.servers = [];
    this.hints = [];
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
    return this.state();
  }
  async start(input: {
    target: string;
    certificate: string;
    privateKey: string;
    certificateFingerprint: string;
  }) {
    await this.stop();
    const cert = new X509Certificate(input.certificate);
    if (
      createHash("sha256").update(cert.raw).digest("hex") !== input.certificateFingerprint ||
      Date.parse(cert.validTo) <= Date.now()
    )
      throw new Error("Pair your phone again with this home.");
    const hints = deviceConnectionHints();
    if (!hints.length) throw new Error("Connect this Mac to your network first.");
    try {
      for (const hint of hints) {
        const server = createServer(
          {
            key: input.privateKey,
            cert: input.certificate,
            minVersion: "TLSv1.2",
            requestTimeout: 15_000,
            headersTimeout: 10_000,
          },
          deviceProxy(input.target),
        );
        this.servers.push(server);
        server.on("upgrade", (_req, socket) => socket.destroy());
        server.on("clientError", (_error, socket) => socket.destroy());
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(DEVICE_LISTENER_PORT, new URL(hint).hostname, () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        server.on("error", () => {
          void this.stop();
        });
      }
      this.hints = hints;
      return this.state();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
}
