import { connectMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";

export type RemoteMcpCredential = { value: string; headerName?: string | null };

/**
 * Connects a remote MCP server and trusts only the connection state the API recorded.
 * "mixed" servers try browser sign-in first and return "needs-credential" when the server
 * offers none. "cancelled" means the person stopped browser sign-in.
 */
export async function connectRemoteMcp(input: {
  name: string;
  endpoint: string;
  botId?: string;
  auth?: "none" | "oauth" | "mixed";
  credential?: RemoteMcpCredential;
}): Promise<{ serverId: string } | "cancelled" | "needs-credential"> {
  const endpoint = input.endpoint.trim();
  const value = input.credential?.value.trim();
  const headerName = input.credential?.headerName;
  const headers = value && headerName ? { [headerName]: value } : undefined;
  const secret = value && !headers ? value : undefined;
  const key = serverEndpointKey(endpoint);
  const existing = (await rpc.mcp.servers.list()).find(
    (server) =>
      !server.catalogId &&
      !server.managedBy &&
      server.endpoint &&
      serverEndpointKey(server.endpoint) === key,
  );
  const server =
    existing ??
    (await rpc.mcp.servers.create({
      slug: `integration-${crypto.randomUUID().slice(0, 8)}`,
      name: input.name,
      transport: "streamable_http",
      endpoint,
      ...(headers ? { headers } : secret ? { secret } : {}),
    }));
  if (existing?.endpoint && headers)
    await rpc.mcp.servers.update({
      id: existing.id,
      config: {
        slug: existing.slug,
        name: existing.name,
        description: existing.description,
        enabled: existing.enabled,
        transport: existing.transport === "sse" ? "sse" : "streamable_http",
        endpoint: existing.endpoint,
        headers,
      },
    });
  else if (existing && secret) await rpc.mcp.servers.update({ id: existing.id, secret });
  let failed = false;
  let failure: unknown;
  let cancelled = false;
  try {
    if (value || input.auth === "none") await rpc.mcp.servers.tools({ serverId: server.id });
    else cancelled = (await connectMcpOauth(server.id)) === "cancelled";
  } catch (error) {
    failed = true;
    failure = error;
  }
  const state = (await rpc.mcp.servers.list()).find(
    (candidate) => candidate.id === server.id,
  )?.connectionState;
  if (!failed && !cancelled && state === "connected") {
    if (input.botId) await rpc.mcp.assignments.approve({ botId: input.botId, serverId: server.id });
    return { serverId: server.id };
  }
  const needsCredential = failed && input.auth === "mixed" && state === "needs-sign-in";
  if (needsCredential || (cancelled && state !== "needs-sign-in")) {
    if (!existing) {
      try {
        await rpc.mcp.servers.remove({ id: server.id });
      } catch {
        await rpc.mcp.servers.update({ id: server.id, enabled: false });
      }
    }
    return needsCredential ? "needs-credential" : "cancelled";
  }
  throw failure instanceof Error
    ? failure
    : new Error("Could not connect this server. Check its configuration and try again.");
}

/** Matches built-in apps, whose listings may add tracking query strings. */
export function normalizedEndpoint(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.protocol}//${url.host}${path}`;
}

/** The query can select a different account or workspace, so reuse compares all of it. */
export function serverEndpointKey(value: string): string {
  const url = new URL(value);
  url.searchParams.sort();
  return `${normalizedEndpoint(value)}${url.search}`;
}
