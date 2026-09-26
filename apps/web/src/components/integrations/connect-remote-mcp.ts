import type { McpOauthWait } from "../../lib/mcp-connect";
import { connectMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";

export type RemoteMcpCredential = { value: string; headerName?: string | null };

export type RemoteMcpResult =
  | "connected"
  | "cancelled"
  | "needs-sign-in"
  | "needs-credential"
  | "credential-rejected"
  | "sign-in-failed"
  | "replaced"
  | "oauth-unavailable";

/** `recorded` is the server's lastError after the attempt, for the sentence it is shown as. */
export type RemoteMcpOutcome = {
  serverId: string;
  result: RemoteMcpResult;
  recorded: string | null;
};

/**
 * Connects a remote MCP server and trusts only the connection state the API recorded.
 * A server created here is never removed: the person deletes it. An imported server is
 * never reused; it is edited through Import. "mixed" servers try
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
  signal?: AbortSignal;
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
      !server.imported &&
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
  if (existing && headers) await rpc.mcp.servers.update({ id: existing.id, headers });
  else if (existing && secret) await rpc.mcp.servers.update({ id: existing.id, secret });
  let failed = false;
  let failure: unknown;
  let oauth: Awaited<ReturnType<typeof connectMcpOauth>> | undefined;
  try {
    if (value || input.auth === "none") await rpc.mcp.servers.tools({ serverId: server.id });
    else
      oauth = await connectMcpOauth(server.id, {
        onWaiting: input.onWaiting,
        signal: input.signal,
      });
  } catch (error) {
    failed = true;
    failure = error;
  }
  input.signal?.throwIfAborted();
  const listed = (await rpc.mcp.servers.list()).find((candidate) => candidate.id === server.id);
  const done = (result: RemoteMcpResult): RemoteMcpOutcome => ({
    serverId: server.id,
    result,
    recorded: listed?.lastError ?? null,
  });
  // A declined, unfinished, or failed sign-in is the attempt's outcome even when an
  // older "connected" row is still what the list shows.
  if (
    oauth === "cancelled" ||
    oauth === "needs-sign-in" ||
    oauth === "sign-in-failed" ||
    oauth === "replaced"
  )
    return done(oauth);
  if (oauth === "oauth-unavailable" || listed?.lastError?.includes("oauth_unavailable"))
    return done(!value && input.auth === "mixed" ? "needs-credential" : "oauth-unavailable");
  const state = listed?.connectionState;
  if (!failed && state === "connected") {
    if (input.botId) await rpc.mcp.assignments.approve({ botId: input.botId, serverId: server.id });
    return done("connected");
  }
  // The first prompt has no token yet. A token the server refused stays stored with the server.
  if (value && failed && state === "needs-sign-in") return done("credential-rejected");
  if (!value && failed && input.auth === "mixed" && state === "needs-sign-in")
    return done("needs-credential");
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
