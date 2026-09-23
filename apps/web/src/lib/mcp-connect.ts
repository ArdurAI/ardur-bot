import { rpc } from "./rpc";

export const MCP_OAUTH_CHANNEL = "ardurbot-mcp-oauth";
const MCP_OAUTH_TIMEOUT_MS = 2 * 60 * 1000;

export type McpOauthResult =
  | "connected"
  | "cancelled"
  | "already_connected"
  | "authorization_not_requested";

/** Run the browser OAuth popup flow for an MCP server: request an
 * authorization URL, open the popup, and wait until the callback page
 * broadcasts completion or the popup is closed without finishing.
 *
 * The BroadcastChannel (not window.opener) is the completion signal because
 * provider login pages with COOP sever the opener link. */
export async function connectMcpOauth(serverId: string): Promise<McpOauthResult> {
  const started = await rpc.mcp.oauth.begin({
    serverId,
    redirectUri: `${window.location.origin}/mcp/oauth/callback`,
  });
  if (started.status !== "authorization_required") return started.status;
  return waitForMcpOauth(started.authorizationUrl, undefined, started.sessionId);
}

export async function waitForMcpOauth(
  authorizationUrl: string,
  existingPopup?: Window | null,
  sessionId?: string | null,
): Promise<McpOauthResult> {
  const popup =
    existingPopup === undefined
      ? window.open(authorizationUrl, MCP_OAUTH_CHANNEL, "popup,width=560,height=720")
      : existingPopup;
  if (existingPopup) existingPopup.location.href = authorizationUrl;
  if (!popup) {
    // Popup blocked: navigate this tab instead; the callback page returns to /app.
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
    pollTimer = window.setInterval(() => {
      if (!popup.closed) return;
      finish("cancelled");
    }, 500);
    timeoutTimer = window.setTimeout(() => {
      popup.close();
      finish("cancelled");
    }, MCP_OAUTH_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; sessionId?: string } | null;
      if (data?.type !== "mcp-oauth-complete" || (sessionId && data.sessionId !== sessionId))
        return;
      finish("connected");
    };
  });
}
