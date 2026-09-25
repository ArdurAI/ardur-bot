import { desktopBridge } from "./desktop";
import type { McpOauthResult } from "./mcp-oauth-channel";
import { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";
import { rpc } from "./rpc";

export type { McpOauthResult };
export { MCP_OAUTH_CHANNEL };

const MCP_OAUTH_TIMEOUT_MS = 10 * 60 * 1000;
const POPUP_CLOSED_GRACE_MS = 1_500;
const DECLINED_WHILE_CONNECTED = "Sign-in was declined.";

/** A post-consent failure is stored as "discovery-failed" and reported as "sign-in-failed". */
function recordedOauthOutcome(server: {
  connectionState?: string;
  lastError?: string | null;
}): McpOauthResult | null {
  if (server.connectionState === "connected") {
    if (!server.lastError) return "connected";
    if (server.lastError === DECLINED_WHILE_CONNECTED) return "cancelled";
    return "sign-in-failed";
  }
  if (server.connectionState === "discovery-failed") return "sign-in-failed";
  if (server.connectionState === "cancelled") return "cancelled";
  if (server.connectionState === "needs-sign-in") return "needs-sign-in";
  return null;
}

/** Run the browser OAuth popup flow for an MCP server: request an
 * authorization URL, open the popup, and wait until this attempt's pending
 * session id is cleared or replaced. */
export async function connectMcpOauth(serverId: string): Promise<McpOauthResult> {
  const started = await rpc.mcp.oauth.begin({
    serverId,
    redirectUri: `${window.location.origin}/api/oauth/done`,
  });
  if (started.status !== "authorization_required") return started.status;
  return waitForMcpOauth(started.authorizationUrl, undefined, started.sessionId, async () => {
    const server = (await rpc.mcp.servers.list()).find((item) => item.id === serverId);
    if (!server) return null;
    if (server.pendingOauthSessionId === started.sessionId) return null;
    if (server.pendingOauthSessionId) return "replaced";
    return recordedOauthOutcome(server);
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
    let polling = false;
    let closedFor = 0;
    let pollTimer = 0;
    let closedTimer = 0;
    let timeoutTimer = 0;
    const finish = (result: McpOauthResult) => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollTimer);
      window.clearInterval(closedTimer);
      window.clearTimeout(timeoutTimer);
      channel.close();
      resolve(result);
    };
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
    closedTimer = window.setInterval(() => {
      if (!popup || settled) return;
      if (!popup.closed) {
        closedFor = 0;
        return;
      }
      closedFor += 200;
      if (closedFor >= POPUP_CLOSED_GRACE_MS) finish("needs-sign-in");
    }, 200);
    timeoutTimer = window.setTimeout(() => {
      popup?.close();
      // The person closed the window or never finished. That is not a decline.
      finish("needs-sign-in");
    }, MCP_OAUTH_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; sessionId?: string } | null;
      if (data?.type !== "mcp-oauth-complete" || (sessionId && data.sessionId !== sessionId))
        return;
      if (!outcome) {
        finish("connected");
        return;
      }
      void outcome().then((result) => {
        if (result) finish(result);
      });
    };
  });
}
