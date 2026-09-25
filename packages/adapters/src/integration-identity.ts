import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { redactConnectorPayload } from "./connector-safety.js";

type IdentityCall = { name: string; args: Record<string, string> };
const calls: Record<string, IdentityCall> = {
  github: { name: "get_me", args: {} },
  gitlab: { name: "get_current_user", args: {} },
  atlassian: { name: "atlassianUserInfo", args: {} },
  notion: { name: "notion-get-users", args: { user_id: "self" } },
  linear: { name: "get_user", args: { query: "me" } },
};

/** Only fixed identity operations from the catalog may run during account inspection. */
export function integrationIdentityCall(
  catalogId: string | null,
  tools: Array<{
    name: string;
    inputSchema: { properties?: Record<string, unknown>; required?: string[] };
  }>,
): IdentityCall | undefined {
  const call =
    catalogId === "notion" &&
    tools.some((tool) => tool.name === "notion-fetch" && tool.inputSchema.properties?.id)
      ? { name: "notion-fetch", args: { id: "self" } }
      : catalogId
        ? calls[catalogId]
        : undefined;
  const tool = call && tools.find((tool) => tool.name === call.name);
  if (
    !call ||
    !tool ||
    Object.keys(call.args).some((key) => !tool.inputSchema.properties?.[key]) ||
    tool.inputSchema.required?.some((key) => !(key in call.args))
  )
    return;
  return call;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const label = (value: unknown) =>
  typeof value === "string"
    ? [...value]
        .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
        .join("")
        .slice(0, 240) || null
    : null;

export function integrationIdentity(result: CallToolResult, secrets: string[]) {
  if (result.isError) return { account: null, workspace: null };
  let payload: unknown = result.structuredContent;
  if (!payload) {
    for (const block of result.content) {
      if (block.type !== "text") continue;
      try {
        payload = JSON.parse(block.text);
        break;
      } catch {
        /* No identity is inferred from prose. */
      }
    }
  }
  const response = object(redactConnectorPayload(payload, secrets));
  const data = object(response.self ?? response);
  const users = Array.isArray(data.users)
    ? data.users
    : Array.isArray(data.results)
      ? data.results
      : [];
  const user = object(data.user ?? data.profile ?? users[0] ?? data);
  return {
    account: label(user.login ?? user.username ?? user.displayName ?? user.name ?? user.email),
    workspace: label(
      object(data.workspace).name ??
        object(user.bot).workspace_name ??
        object(user.organization).name,
    ),
  };
}
