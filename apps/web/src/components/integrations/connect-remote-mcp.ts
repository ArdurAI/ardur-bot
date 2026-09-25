import type { McpOauthWait } from "../../lib/mcp-connect";
import { connectMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";

export type RemoteMcpCredential = { value: string; headerName?: string | null };

export type RemoteMcpOutcome =
  | { serverId: string }
  | "cancelled"
  | "needs-sign-in"
  | "needs-credential"
  | "credential-rejected"
  | "sign-in-failed"
  | "replaced";

/**
 * Connects a remote MCP server and trusts only the connection state the API recorded.
 * A server created here is never removed: the person deletes it. "mixed" servers try
 * browser sign-in first and return "needs-credential" when the server offers none.
 * A token the server rejects returns "credential-rejected". "cancelled" means the
 * person declined or cancelled. "needs-sign-in" means the attempt expired before
 * sign-in finished.
 * "sign-in-failed" means token exchange or discovery failed after consent.
 * "replaced" means a newer sign-in window took over this attempt.
 */
export async function connectRemoteMcp(input: {
  name: string;
  endpoint: string;
  botId?: string;
  auth?: "none" | "oauth" | "mixed";
  credential?: RemoteMcpCredential;
  onWaiting?: (waiting: McpOauthWait) => void;
}): Promise<RemoteMcpOutcome> {
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
  let oauth: Awaited<ReturnType<typeof connectMcpOauth>> | undefined;
  try {
    if (value || input.auth === "none") await rpc.mcp.servers.tools({ serverId: server.id });
    else oauth = await connectMcpOauth(server.id, { onWaiting: input.onWaiting });
  } catch (error) {
    failed = true;
    failure = error;
  }
  // A declined, unfinished, or failed sign-in is the attempt's outcome even when an
  // older "connected" row is still what the list shows.
  if (
    oauth === "cancelled" ||
    oauth === "needs-sign-in" ||
    oauth === "sign-in-failed" ||
    oauth === "replaced"
  )
    return oauth;
  const state = (await rpc.mcp.servers.list()).find(
    (candidate) => candidate.id === server.id,
  )?.connectionState;
  if (!failed && state === "connected") {
    if (input.botId) await rpc.mcp.assignments.approve({ botId: input.botId, serverId: server.id });
    return { serverId: server.id };
  }
  // The first prompt has no token yet. A token the server refused stays stored with the server.
  if (value && failed && state === "needs-sign-in") return "credential-rejected";
  if (!value && failed && input.auth === "mixed" && state === "needs-sign-in")
    return "needs-credential";
  throw failure instanceof Error
    ? failure
    : new Error("Could not connect this server. Check its configuration and try again.");
}

function endpointIdentity(value: string): { originPath: string; query: string } {
  const url = new URL(value);
  url.searchParams.sort();
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return { originPath: `${url.protocol}//${url.host}${path}`, query: url.search };
}

/**
 * A built-in app matches when scheme, host and path match and the address query is empty
 * or equal, after sorting, to the catalog endpoint's query. Any other query is a custom server.
 */
export function matchesCatalogEndpoint(candidate: string, catalogEndpoint: string): boolean {
  try {
    const left = endpointIdentity(candidate);
    const right = endpointIdentity(catalogEndpoint);
    return (
      left.originPath === right.originPath && (left.query === "" || left.query === right.query)
    );
  } catch {
    return false;
  }
}

/** The query can select a different account or workspace, so reuse compares all of it. */
export function serverEndpointKey(value: string): string {
  const identity = endpointIdentity(value);
  return `${identity.originPath}${identity.query}`;
}
