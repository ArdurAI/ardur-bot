import { desktopBridge } from "./desktop";
import type { McpOauthResult } from "./mcp-oauth-channel";
import { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";
import { rpc } from "./rpc";

export type { McpOauthResult };
export { MCP_OAUTH_CHANNEL };

const MCP_OAUTH_TIMEOUT_MS = 10 * 60 * 1000;
const DECLINED_WHILE_CONNECTED = "Sign-in was declined.";

export type McpOauthWait = {
  sessionId: string;
  cancel: () => Promise<void>;
};

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
 * session id is cleared or replaced. The popup's closed flag is not an
 * outcome; provider pages sever the opener while sign-in is still open. */
export async function connectMcpOauth(
  serverId: string,
  options?: { onWaiting?: (waiting: McpOauthWait) => void },
): Promise<McpOauthResult> {
  let started: Awaited<ReturnType<typeof rpc.mcp.oauth.begin>>;
  try {
    started = await rpc.mcp.oauth.begin({
      serverId,
      redirectUri: `${window.location.origin}/api/oauth/done`,
    });
  } catch (error) {
    const server = (await rpc.mcp.servers.list()).find((item) => item.id === serverId);
    if (server && recordedOauthOutcome(server) === "sign-in-failed") return "sign-in-failed";
    throw error;
  }
  if (started.status !== "authorization_required") return started.status;
  return waitForMcpOauth(
    started.authorizationUrl,
    undefined,
    started.sessionId,
    async () => {
      const server = (await rpc.mcp.servers.list()).find((item) => item.id === serverId);
      if (!server) return null;
      if (server.pendingOauthSessionId === started.sessionId) return null;
      if (server.pendingOauthSessionId) return "replaced";
      return recordedOauthOutcome(server);
    },
    {
      onWaiting: options?.onWaiting,
      cancel: async () => {
        await rpc.mcp.oauth.cancel({ serverId, sessionId: started.sessionId });
      },
    },
  );
}

export async function waitForMcpOauth(
  authorizationUrl: string,
  existingPopup?: Window | null,
  sessionId?: string | null,
  outcome?: () => Promise<McpOauthResult | null>,
  hooks?: {
    onWaiting?: (waiting: McpOauthWait) => void;
    cancel?: () => Promise<void>;
  },
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
    let cancelRequested = false;
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
    const cancel = async () => {
      if (settled || cancelRequested) return;
      cancelRequested = true;
      try {
        await hooks?.cancel?.();
      } catch {
        cancelRequested = false;
        return;
      }
      if (settled) return;
      popup?.close();
      await desktop?.focus();
      finish("cancelled");
    };
    pollTimer = window.setInterval(() => {
      if (!outcome || polling || cancelRequested) return;
      polling = true;
      void outcome()
        .then(async (result) => {
          if (!result || settled || cancelRequested) return;
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
      // The attempt expired. That is not a decline.
      finish("needs-sign-in");
    }, MCP_OAUTH_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; sessionId?: string; result?: string } | null;
      if (data?.type !== "mcp-oauth-complete" || (sessionId && data.sessionId !== sessionId))
        return;
      if (data.result === "replaced") {
        finish("replaced");
        return;
      }
      if (!outcome) {
        finish("connected");
        return;
      }
      void outcome().then((result) => {
        if (result && !cancelRequested) finish(result);
      });
    };
    if (sessionId) hooks?.onWaiting?.({ sessionId, cancel });
  });
}
