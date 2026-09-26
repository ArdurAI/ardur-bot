import * as z from "zod";

export const McpTransportSchema = z.enum(["streamable_http", "sse", "stdio"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export function isLocalMcpHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export const McpRemoteEndpointSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      if (value.endsWith("#")) return false;
      const url = new URL(value);
      if (url.username || url.password || url.hash) return false;
      if (url.protocol === "https:") return true;
      return url.protocol === "http:" && isLocalMcpHost(url.hostname);
    } catch {
      return false;
    }
  }, "MCP remote endpoint must be an HTTPS URL without credentials or a fragment (HTTP is allowed only for localhost)");

export const McpHeadersSchema = z
  .record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(4096))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 32) {
      ctx.addIssue({ code: "custom", message: "At most 32 headers are allowed" });
    }
  });

/**
 * The lastError a server records when a person must act before it works again. The code
 * says why: `credential_rejected` (a saved token or header was refused), `invalid_token`
 * (an OAuth access token was refused), `refresh_unavailable` (a saved sign-in expired),
 * `oauth_unavailable` (the server offers no browser sign-in), or an OAuth error code.
 */
export function mcpSignInDiagnostic(code?: string | null): string {
  return code ? `Needs sign-in (${code}).` : "Needs sign-in.";
}
