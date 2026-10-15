import { request } from "node:https";
import type { TLSSocket } from "node:tls";
import { canonicalDispatchJson } from "@ardurbot/contracts";
import { certificateMatches } from "./crypto.js";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3 = 1,
  ) {
    super(message);
  }
}
export const HOME_CHANGED = "This home's identity changed; pair this device again.";
export const HOME_UNREACHABLE = "Home unreachable — check that Ardur is running";
export type Transport = (
  url: string,
  fingerprint: string,
  body: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
export const pinnedPost: Transport = (url, fingerprint, body, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CliError("Waiting stopped."));
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    )
      return reject(new CliError("Choose an HTTPS home.", 3));
    const encoded = canonicalDispatchJson(body);
    // Home uses a self-signed certificate. Its exact out-of-band pin, validity
    // and later signed nonce proof replace public-CA trust, never an insecure mode.
    const req = request(
      target,
      {
        method: "POST",
        agent: false,
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(encoded),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) req.destroy(new CliError("Home returned too much data."));
          else chunks.push(chunk);
        });
        res.on("error", () => reject(new CliError(HOME_UNREACHABLE)));
        res.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const status = res.statusCode ?? 500;
            if (status < 200 || status >= 300) {
              // Do not echo arbitrary remote error data or redirects.
              const message =
                typeof result.message === "string" && result.message.startsWith("This device")
                  ? "This device is unavailable; pair it again at home."
                  : status === 401 || status === 403
                    ? "This action is unavailable from this device."
                    : "Home could not finish this request; try again.";
              return reject(new CliError(message, status === 401 || status === 403 ? 2 : 1));
            }
            resolve(result);
          } catch {
            reject(new CliError(HOME_UNREACHABLE));
          }
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new CliError(HOME_UNREACHABLE)), 15_000);
    const abort = () => req.destroy(new CliError("Waiting stopped."));
    signal?.addEventListener("abort", abort, { once: true });
    req.once("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
    req.once("error", (error) =>
      reject(error instanceof CliError ? error : new CliError(HOME_UNREACHABLE)),
    );
    req.once("socket", (socket) => {
      const tls = socket as TLSSocket;
      tls.once("secureConnect", () => {
        if (signal?.aborted || req.destroyed) return;
        const cert = tls.getPeerCertificate();
        if (!cert.raw || !certificateMatches(cert.raw, fingerprint)) {
          req.destroy(new CliError(HOME_CHANGED, 2));
          return;
        }
        // No HTTP headers or request body leave before the certificate is checked.
        req.end(encoded);
      });
    });
  });
