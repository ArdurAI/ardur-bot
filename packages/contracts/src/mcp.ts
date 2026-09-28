import * as z from "zod";

export const McpTransportSchema = z.enum(["streamable_http", "sse", "stdio"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

/** Flags live beside values in the encrypted MCP material. Missing flags mean
 * a legacy entry and must be treated as secret. */
export const McpCredentialFlagsSchema = z.object({
  env: z.record(z.string(), z.boolean()).default({}),
  headers: z.record(z.string(), z.boolean()).default({}),
});
export type McpCredentialFlags = z.infer<typeof McpCredentialFlagsSchema>;

const plainConfigurationNames = new Set([
  "LOG_LEVEL",
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "NODE_ENV",
  "DEBUG",
]);

export function defaultMcpEntrySecret(name: string): boolean {
  return !plainConfigurationNames.has(name.toUpperCase());
}

export function mcpEntryIsSecret(
  flags: Partial<McpCredentialFlags> | undefined,
  kind: keyof McpCredentialFlags,
  name: string,
): boolean {
  return flags?.[kind]?.[name] !== false;
}

/** Preserve an owner's choices; only genuinely new entries receive name defaults. */
export function mcpCredentialFlagsForEntries(
  previous: {
    env?: Record<string, string>;
    headers?: Record<string, string>;
    credentialFlags?: Partial<McpCredentialFlags>;
  },
  next: { env?: Record<string, string>; headers?: Record<string, string> },
): McpCredentialFlags {
  const flags: McpCredentialFlags = { env: {}, headers: {} };
  for (const kind of ["env", "headers"] as const) {
    for (const name of Object.keys(next[kind] ?? {})) {
      flags[kind][name] = Object.hasOwn(previous[kind] ?? {}, name)
        ? mcpEntryIsSecret(previous.credentialFlags, kind, name)
        : defaultMcpEntrySecret(name);
    }
  }
  return flags;
}

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

/**
 * Recorded as lastError when a person declines a re-authorization of a server that stays
 * connected on its prior tokens. Never a `mcpSignInDiagnostic`: the server does not need
 * sign-in.
 */
export function mcpReauthorizationDeclinedDiagnostic(): string {
  return "Sign-in was declined.";
}

/** True when `recorded` is the declined-re-authorization diagnostic. One source of
 * truth: compares against the sentence above instead of duplicating it in a regex. */
export function isReauthorizationDeclined(recorded: string | null | undefined): boolean {
  return recorded?.trim() === mcpReauthorizationDeclinedDiagnostic();
}

/** The ORPC error code for a typed token that fails basic validation before any attempt
 * is made to use it. Carried in the error's `data`, not its message. */
export const MCP_INVALID_TOKEN_CODE = "invalid_token";

export const MCP_ONE_CREDENTIAL = "Choose one credential: a token or a header.";

/** A server stores either a bearer token or a named header, never both. */
export function mcpCredentialConflict(input: {
  secret?: string;
  headers?: Record<string, string>;
}): string | null {
  const secret = input.secret?.trim() ?? "";
  const headers = input.headers ?? {};
  const named = Object.values(headers).some((value) => value.trim());
  return secret && named ? MCP_ONE_CREDENTIAL : null;
}
