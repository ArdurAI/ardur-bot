import type { IntegrationConnection, IntegrationDescriptor } from "@ardurbot/contracts";
import { abortableDelay } from "@ardurbot/core";
import { desktopBridge } from "./desktop";
import { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";
import { rpc } from "./rpc";

/** Polling survives browser-profile changes and providers that sever the popup opener.
 * Aborting `signal` stops this page's polling; the sign-in itself continues. */
export async function connectIntegration(
  descriptor: IntegrationDescriptor,
  connection?: IntegrationConnection,
  options: {
    token?: string;
    host?: string;
    authKind?: "oauth" | "token" | "host";
    oauthClient?: { clientId: string; clientSecret?: string };
    onPopup?: (popup: Window | null) => void;
    onStarted?: (connection: IntegrationConnection) => void;
    onWaiting?: (waiting: { cancel: () => Promise<void> }) => void;
    signal?: AbortSignal;
  } = {},
) {
  const authKind = options.authKind ?? descriptor.authKind;
  const desktop = desktopBridge()?.integrations;
  const popup =
    authKind === "oauth" && !desktop
      ? window.open("about:blank", MCP_OAUTH_CHANNEL, "popup,width=560,height=720")
      : null;
  options.onPopup?.(popup);
  try {
    const started = await rpc.integrations.connect({
      catalogId: descriptor.id,
      connectionId: connection?.id,
      authKind,
      token: authKind === "token" ? options.token : undefined,
      host: options.host,
      ...(options.oauthClient ? { oauthClient: options.oauthClient } : {}),
    });
    options.onStarted?.(started.connection);
    if (!started.authorizationUrl) {
      popup?.close();
      return started.connection;
    }
    if (desktop) await desktop.open(started.authorizationUrl);
    else if (popup) popup.location.href = started.authorizationUrl;
    else {
      window.location.assign(started.authorizationUrl);
      return started.connection;
    }
    options.onWaiting?.({
      cancel: async () => {
        await rpc.integrations.cancel({ connectionId: started.connection.id });
        popup?.close();
      },
    });
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await abortableDelay(1000, options.signal);
      // Leaving the page stops this loop here; the sign-in itself keeps running.
      if (options.signal?.aborted) return started.connection;
      let current: IntegrationConnection;
      try {
        current = await rpc.integrations.status({ connectionId: started.connection.id });
      } catch {
        continue;
      }
      if (current.state === "awaiting-consent") continue;
      if (current.state === "connected") {
        popup?.close();
        await desktop?.focus();
      }
      return current;
    }
    if (options.signal?.aborted) return started.connection;
    return await rpc.integrations.status({ connectionId: started.connection.id });
  } catch (error) {
    popup?.close();
    throw error;
  } finally {
    options.onPopup?.(null);
  }
}

/** A built-in app's web connection. Its host sign-in connection is never this one. */
export function remoteConnection(
  connections: IntegrationConnection[],
  catalogId: string,
): IntegrationConnection | undefined {
  return connections.find((row) => row.catalogId === catalogId && row.transport !== "host-cli");
}
