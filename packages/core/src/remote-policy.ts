import type { DeviceScope } from "@ardurbot/contracts";
import { ALL_DEVICE_SCOPES } from "@ardurbot/contracts";

export type RemoteAuthority = Readonly<
  Record<"home" | "space" | "bot" | "user" | "device", readonly string[]>
>;
export const REMOTE_PRESENCE_MAX_AGE_MS = 10 * 60_000;

export function effectiveRemoteAuthority(authority: RemoteAuthority): DeviceScope[] {
  return ALL_DEVICE_SCOPES.filter((scope) =>
    Object.values(authority).every((layer) => layer.includes(scope)),
  );
}

// Positive allowlist: connector naming, model hints and approval exemptions are not risk evidence.
const ORDINARY_TOOLS = new Set([
  "computer_observe",
  "browser_snapshot",
  "list_files",
  "read_file",
  "web_search",
  "web_fetch",
  "recall_memory",
  "scratchpad_list",
  "skill_read",
  "schedule_list",
  "cloud_agent_status",
  "ask_user",
  "request_takeover",
  "message_user",
  "report_progress",
  "attach_artifact",
  "complete_task",
  "run_subagent",
  "message_bot",
  "spawn_bot",
  "handoff_to_bot",
]);
const DELEGATION_TOOLS = new Set(["run_subagent", "message_bot", "spawn_bot", "handoff_to_bot"]);
const FORBIDDEN_TOOLS = new Set([
  "add_mcp_server",
  "cloud_agent_launch",
  "cloud_agent_reply",
  "create_space",
  "connect_agent",
  "respond_agent_connection",
  "message_agent",
  "schedule_create",
  "secret_request",
  "request_secret",
  "forget_secret",
  "enrol_connector",
  "pair_device",
  "set_tool_policy",
  "always_allow",
  "update_bot",
]);
export function remotePermissionExpansion(tool: string): boolean {
  return (
    FORBIDDEN_TOOLS.has(tool) ||
    /(?:^|[._-])(?:pairing|enroll?|polic(?:y|ies)|permissions?|credentials?|always_allow)(?:[._-]|$)/i.test(
      tool,
    )
  );
}
export function classifyRemoteTool(tool: string): "ordinary" | "consequential" {
  return ORDINARY_TOOLS.has(tool) ? "ordinary" : "consequential";
}
export type RemotePolicyDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      action: "Approve on your Mac" | "Confirm on your phone";
    };
export function checkRemoteTool(input: {
  tool: string;
  authority: RemoteAuthority;
  revoked: boolean;
  lastPresenceAt: number | null;
  now: number;
}): RemotePolicyDecision {
  const desktop = (reason: string): RemotePolicyDecision => ({
    allowed: false,
    reason,
    action: "Approve on your Mac",
  });
  if (input.revoked) return desktop("This device is no longer allowed to run work.");
  if (remotePermissionExpansion(input.tool))
    return desktop("Change permissions or connections at home.");
  const scopes = effectiveRemoteAuthority(input.authority);
  if (
    !scopes.includes("dispatch") ||
    !scopes.includes(classifyRemoteTool(input.tool)) ||
    (DELEGATION_TOOLS.has(input.tool) && !scopes.includes("delegate"))
  ) {
    return desktop("This action needs approval at home.");
  }
  if (
    classifyRemoteTool(input.tool) === "consequential" &&
    (input.lastPresenceAt === null ||
      input.lastPresenceAt > input.now ||
      input.now - input.lastPresenceAt >= REMOTE_PRESENCE_MAX_AGE_MS)
  ) {
    return {
      allowed: false,
      reason: "Confirm your presence before this action runs.",
      action: "Confirm on your phone",
    };
  }
  return { allowed: true };
}
