import type { McpServerConfigInput } from "@ardurbot/contracts";
import { redactMcpArguments } from "@ardurbot/host-runtime/mcp-diagnostics";

/** Shape of the encrypted MCP credential blob. `oauth` holds SDK OAuth state
 * (tokens, client registration, PKCE verifier) managed by McpOAuthBroker. */
export type McpSecretMaterial = {
  args?: string[];
  command?: string;
  cwd?: string;
  secret?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: Record<string, unknown>;
};

export type McpMaterialUpdate =
  | { action: "keep" }
  | { action: "store"; material: McpSecretMaterial };

/** Compute the next encrypted credential blob for an MCP server update.
 *
 * - "keep": the update carries no credential data; leave the stored blob as is.
 * - "store": rewrite the blob. An empty material means credentials were
 *   cleared entirely — the caller should delete the secret row and null the
 *   server's secretId instead of storing an empty object.
 *
 * env/headers use full-replace semantics (the update payload is the complete
 * set), matching the create handler. OAuth state is preserved unless the
 * endpoint changed, since tokens issued for one endpoint must never be sent to
 * another server. */
export function buildMcpUpdateMaterial(
  existing: McpSecretMaterial,
  config: McpServerConfigInput,
  options: { clearOAuth?: boolean } = {},
): McpMaterialUpdate {
  const material = options.clearOAuth ? { ...existing } : existing;
  const clearedOAuth = options.clearOAuth === true && material.oauth !== undefined;
  if (options.clearOAuth) delete material.oauth;
  const args =
    config.transport === "stdio" && config.args
      ? config.args.map((arg, i) =>
          arg === redactMcpArguments(material.args ?? [], Object.values(material.env ?? {}))[i]
            ? (material.args?.[i] ?? arg)
            : arg,
        )
      : undefined;
  const clearing = config.clearCredential === true;
  if (clearing) {
    return {
      action: "store",
      material: { ...(material.oauth ? { oauth: material.oauth } : {}), ...(args ? { args } : {}) },
    };
  }
  const secret = "secret" in config && config.secret ? config.secret : undefined;
  const env = "env" in config ? config.env : undefined;
  const headers = "headers" in config ? config.headers : undefined;
  const namedHeaders = headers && Object.keys(headers).length > 0 ? headers : undefined;
  const existingHasMaterial = Boolean(
    material.secret ||
      (material.env && Object.keys(material.env).length > 0) ||
      (material.headers && Object.keys(material.headers).length > 0) ||
      material.oauth ||
      material.args,
  );
  const suppliesMaterial = Boolean(
    args ||
      secret ||
      (env && Object.keys(env).length > 0) ||
      (headers && Object.keys(headers).length > 0),
  );
  if (!existingHasMaterial && !suppliesMaterial) {
    return clearedOAuth ? { action: "store", material } : { action: "keep" };
  }
  // One credential per server: a bearer replaces a named header, and a named header
  // replaces a bearer. Echoing the previous header beside a new bearer still clears it.
  const next: McpSecretMaterial = {
    ...material,
    ...(args ? { args, command: config.transport === "stdio" ? config.command : undefined } : {}),
    ...(env !== undefined ? { env } : {}),
  };
  if (secret) {
    next.secret = secret;
    delete next.headers;
  } else if (namedHeaders) {
    next.headers = namedHeaders;
    delete next.secret;
  } else if (headers !== undefined) next.headers = headers;
  return { action: "store", material: next };
}
