import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { HostProviderGrant } from "@ardurbot/contracts/host-bridge";
import { HostProviderOpenSchema, HostProviderReadSchema } from "@ardurbot/contracts/host-bridge";

type ProviderMethod = "provider.open" | "provider.read" | "provider.cancel";
const REQUEST_BYTES = 256 * 1024;
const RESPONSE_BYTES = 8 * 1024 * 1024;

/** A one-turn HTTP facade. All provider policy and credentials remain with the worker. */
export async function startHermesProviderRelay(
  grant: HostProviderGrant,
  callback: (method: ProviderMethod, args: unknown[]) => Promise<unknown>,
  onFailure?: () => void,
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
    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > REQUEST_BYTES) throw new Error("Provider request exceeded the limit.");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const opened = HostProviderOpenSchema.parse(await callback("provider.open", [body]));
      let total = 0;
      let seq = 0;
      res.writeHead(opened.status, { "content-type": opened.contentType });
      while (!closed && Date.now() < grant.expiresAt) {
        const next = HostProviderReadSchema.parse(await callback("provider.read", [seq]));
        if (next.seq !== seq++) throw new Error("Provider response sequence changed.");
        const content = Buffer.from(next.chunk, "base64");
        total += content.length;
        if (total > RESPONSE_BYTES) throw new Error("Provider response exceeded the limit.");
        if (content.length && !res.write(content))
          await new Promise<void>((resolve, reject) => {
            res.once("drain", resolve);
            res.once("close", () => reject(new Error("Provider client disconnected.")));
          });
        if (next.done) {
          completed = true;
          res.end();
          return;
        }
      }
      throw new Error("Provider grant expired.");
    } catch {
      onFailure?.();
      if (!res.headersSent) res.writeHead(502).end("Provider request failed.");
      else res.destroy();
    } finally {
      busy = false;
      active = undefined;
      if (!completed)
        void Promise.resolve()
          .then(() => callback("provider.cancel", []))
          .catch(() => undefined);
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
