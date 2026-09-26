export const MCP_OAUTH_CHANNEL = "ardurbot-mcp-oauth";

export type McpOauthResult =
  | "connected"
  | "needs-sign-in"
  | "cancelled"
  | "sign-in-failed"
  | "replaced"
  | "already_connected"
  | "authorization_not_requested"
  | "oauth-unavailable"
  | "disabled";
