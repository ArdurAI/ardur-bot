import type { IntegrationConnection, IntegrationDescriptor } from "@ardurbot/contracts";
import { MCP_OAUTH_CHANNEL, waitForMcpOauth } from "./mcp-connect";
import { rpc } from "./rpc";

/** Call in the selection gesture so browser consent windows are not blocked. */
export async function connectIntegration(
  descriptor: IntegrationDescriptor,
  connection?: IntegrationConnection,
  options: {
    token?: string;
    host?: string;
    authKind?: "oauth" | "token";
    onPopup?: (popup: Window | null) => void;
    onStarted?: (connection: IntegrationConnection) => void;
  } = {},
) {
  const authKind = options.authKind ?? descriptor.authKind;
  const popup =
    authKind === "oauth"
      ? window.open("about:blank", MCP_OAUTH_CHANNEL, "popup,width=560,height=720")
      : null;
  options.onPopup?.(popup);
  try {
    const started = await rpc.integrations.connect({
      catalogId: descriptor.id,
      connectionId: connection?.id,
      ...(authKind === "token"
        ? { token: options.token, authKind }
        : descriptor.authKind === "token"
          ? { authKind }
          : {}),
      host: options.host,
    });
    options.onStarted?.(started.connection);
    if (started.authorizationUrl) {
      const result = await waitForMcpOauth(started.authorizationUrl, popup, started.sessionId);
      if (result === "cancelled")
        await rpc.integrations.cancel({ connectionId: started.connection.id });
    } else popup?.close();
    return started.connection;
  } catch (error) {
    popup?.close();
    throw error;
  } finally {
    options.onPopup?.(null);
  }
}
