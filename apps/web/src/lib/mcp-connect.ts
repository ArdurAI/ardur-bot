import { desktopBridge } from "./desktop";
import { rpc } from "./rpc";

export const MCP_OAUTH_CHANNEL = "ardurbot-mcp-oauth";
const MCP_OAUTH_TIMEOUT_MS = 10 * 60 * 1000;

export type McpOauthResult =
  | "connected"
  | "needs-sign-in"
  | "cancelled"
  | "sign-in-failed"
  | "already_connected"
  | "authorization_not_requested";

/** A post-consent failure is stored as "discovery-failed" and reported as "sign-in-failed". */
function recordedOauthOutcome(state: string | undefined): McpOauthResult | null {
  if (state === "connected") return "connected";
  if (state === "discovery-failed") return "sign-in-failed";
  if (state === "cancelled") return "cancelled";
  if (state === "needs-sign-in") return "needs-sign-in";
  return null;
}

/** Run the browser OAuth popup flow for an MCP server: request an
 * authorization URL, open the popup, and wait until the callback page
 * broadcasts completion or the API records the sign-in's outcome.
 *
 * The BroadcastChannel (not window.opener) is the completion signal because
 * provider login pages with COOP sever the opener link. An unchanged
 * revision is the previous attempt, not this one. */
export async function connectMcpOauth(serverId: string): Promise<McpOauthResult> {
  const baseline = (await rpc.mcp.servers.list()).find(
    (server) => server.id === serverId,
  )?.revision;
  const started = await rpc.mcp.oauth.begin({
    serverId,
    redirectUri: `${window.location.origin}/api/oauth/done`,
  });
  if (started.status !== "authorization_required") return started.status;
  return waitForMcpOauth(started.authorizationUrl, undefined, started.sessionId, async () => {
    const server = (await rpc.mcp.servers.list()).find((item) => item.id === serverId);
    if (!server || (baseline !== undefined && server.revision === baseline)) return null;
    return recordedOauthOutcome(server.connectionState);
  });
}

export async function waitForMcpOauth(
  authorizationUrl: string,
  existingPopup?: Window | null,
  sessionId?: string | null,
  outcome?: () => Promise<McpOauthResult | null>,
): Promise<McpOauthResult> {
  const desktop = desktopBridge()?.integrations;
  if (desktop) await desktop.open(authorizationUrl);
  const popup = desktop
    ? null
    : existingPopup === undefined
      ? window.open(authorizationUrl, MCP_OAUTH_CHANNEL, "popup,width=560,height=720")
      : existingPopup;
  if (existingPopup) existingPopup.location.href = authorizationUrl;
  if (!popup && !desktop) {
    // The dedicated callback page owns completion even when popups are blocked.
    window.location.assign(authorizationUrl);
    // Navigation owns completion; do not cancel the server-side session.
    return "authorization_not_requested";
  }
  return await new Promise<McpOauthResult>((resolve) => {
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    let settled = false;
    let pollTimer = 0;
    let timeoutTimer = 0;
    const finish = (result: McpOauthResult) => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      channel.close();
      resolve(result);
    };
    let polling = false;
    pollTimer = window.setInterval(() => {
      if (!outcome || polling) return;
      polling = true;
      void outcome()
        .then(async (result) => {
          if (!result || settled) return;
          popup?.close();
          await desktop?.focus();
          finish(result);
        })
        .catch(() => undefined)
        .finally(() => {
          polling = false;
        });
    }, 1000);
    timeoutTimer = window.setTimeout(() => {
      popup?.close();
      // The person closed the window or never finished. That is not a decline.
      finish("needs-sign-in");
    }, MCP_OAUTH_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; sessionId?: string } | null;
      if (data?.type !== "mcp-oauth-complete" || (sessionId && data.sessionId !== sessionId))
        return;
      finish("connected");
    };
  });
}
