import type { HostMcpRegistration } from "@ardurbot/contracts/host-bridge";
import { HostMcpRegistrationSchema, hostSocketUrl } from "@ardurbot/contracts/host-bridge";

export class HostMcpAuthorizationError extends Error {
  constructor() {
    super("This computer is no longer authorized. Connect it again in Settings.");
  }
}

export async function readHostMcpConfiguration(config: {
  apiUrl: string;
  token: string;
}): Promise<HostMcpRegistration[]> {
  hostSocketUrl(config.apiUrl);
  const response = await fetch(new URL("/api/host-bridge/mcp", config.apiUrl), {
    headers: { authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
    cache: "no-store",
  });
  if ([401, 403, 404, 410].includes(response.status)) throw new HostMcpAuthorizationError();
  if (!response.ok || !response.body) throw new Error("Local server configuration is unavailable.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Local server configuration is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return HostMcpRegistrationSchema.array()
    .max(200)
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
