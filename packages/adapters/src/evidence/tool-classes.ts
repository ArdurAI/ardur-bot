import { connectorToolRequiresApproval } from "@ardurbot/core";
import type { ActionClass, SideEffectClass } from "@ardurbot/evidence";

export interface ToolEvidenceClass {
  actionClass: ActionClass;
  sideEffectClass: SideEffectClass;
  resourceFamily: string;
}
const entry = (
  actionClass: ActionClass,
  sideEffectClass: SideEffectClass,
  resourceFamily: string,
): ToolEvidenceClass => ({ actionClass, sideEffectClass, resourceFamily });

export const TOOL_CLASSES = {
  list_bots: entry("read", "none", "bot"),
  search_connectors: entry("search", "none", "connector"),
  report_progress: entry("write", "internal_write", "task"),
  attach_artifact: entry("write", "internal_write", "artifact"),
  complete_task: entry("write", "state_change", "task"),
  // Records the outcome of an earlier action on the chief's plan; it never touches the action itself.
  reconcile_chief_action: entry("write", "state_change", "task"),
  reject_delegation: entry("write", "state_change", "bot"),
  delegation_status: entry("read", "none", "bot"),
  stop_delegation: entry("write", "state_change", "bot"),
  accept_delegation: entry("write", "state_change", "bot"),
  computer_observe: entry("observe", "none", "computer"),
  computer_act: entry("execute", "state_change", "computer"),
  browser_navigate: entry("fetch", "network_read", "web"),
  browser_snapshot: entry("observe", "none", "web"),
  browser_act: entry("execute", "state_change", "web"),
  list_files: entry("read", "none", "file"),
  read_file: entry("read", "none", "file"),
  write_file: entry("write", "filesystem_write", "file"),
  attach_file: entry("write", "internal_write", "file"),
  shell: entry("execute", "process_launch", "process"),
  open_path: entry("execute", "process_launch", "process"),
  launch_app: entry("execute", "process_launch", "process"),
  request_takeover: entry("invoke", "state_change", "computer"),
  ask_user: entry("send", "internal_write", "message"),
  message_user: entry("send", "internal_write", "message"),
  request_secret: entry("invoke", "internal_write", "secret"),
  list_secrets: entry("read", "none", "secret"),
  secret_request: entry("invoke", "network_read", "secret"),
  forget_secret: entry("write", "state_change", "secret"),
  render_plot: entry("write", "internal_write", "artifact"),
  add_mcp_server: entry("write", "state_change", "connector"),
  remember: entry("write", "internal_write", "memory"),
  web_search: entry("search", "network_read", "web"),
  web_fetch: entry("fetch", "network_read", "web"),
  cloud_agent_launch: entry("dispatch", "subagent_launch", "bot"),
  cloud_agent_status: entry("query", "network_read", "bot"),
  cloud_agent_reply: entry("send", "external_send", "bot"),
  cloud_agent_cancel: entry("write", "state_change", "bot"),
  save_memory: entry("write", "internal_write", "memory"),
  recall_memory: entry("read", "none", "memory"),
  forget_memory: entry("write", "state_change", "memory"),
  scratchpad_list: entry("read", "none", "scratchpad"),
  scratchpad_add: entry("write", "internal_write", "scratchpad"),
  scratchpad_update: entry("write", "internal_write", "scratchpad"),
  scratchpad_complete: entry("write", "state_change", "scratchpad"),
  scratchpad_remove: entry("write", "state_change", "scratchpad"),
  schedule_create: entry("write", "internal_write", "schedule"),
  schedule_list: entry("read", "none", "schedule"),
  schedule_cancel: entry("write", "state_change", "schedule"),
  skill_read: entry("read", "none", "skill"),
  skill_create: entry("write", "internal_write", "skill"),
  skill_update: entry("write", "internal_write", "skill"),
  skill_delete: entry("write", "state_change", "skill"),
  run_subagent: entry("dispatch", "subagent_launch", "bot"),
  create_space: entry("write", "state_change", "space"),
  spawn_bot: entry("dispatch", "subagent_launch", "bot"),
  update_bot: entry("write", "state_change", "bot"),
  archive_bot: entry("write", "state_change", "bot"),
  delete_bot: entry("write", "state_change", "bot"),
  message_bot: entry("send", "internal_write", "bot"),
  assign: entry("delegate", "subagent_launch", "bot"),
  handoff_to_bot: entry("delegate", "subagent_launch", "bot"),
  ask_members: entry("send", "internal_write", "bot"),
  board_ready: entry("read", "none", "board"),
  board_show: entry("read", "none", "board"),
  board_create: entry("write", "filesystem_write", "board"),
  board_update: entry("write", "filesystem_write", "board"),
  board_claim: entry("write", "filesystem_write", "board"),
  board_close: entry("write", "filesystem_write", "board"),
  board_comment: entry("write", "filesystem_write", "board"),
  board_link: entry("write", "filesystem_write", "board"),
  connect_agent: entry("send", "external_send", "bot"),
  respond_agent_connection: entry("write", "state_change", "bot"),
  message_agent: entry("send", "external_send", "bot"),
  "destination.write": entry("write", "external_send", "connector"),
} satisfies Record<string, ToolEvidenceClass>;

export function toolEvidenceClass(name: string, viaConnector: boolean): ToolEvidenceClass {
  if (viaConnector)
    return connectorToolRequiresApproval(name)
      ? entry("send", "external_send", "connector")
      : entry("query", "network_read", "connector");
  const known = TOOL_CLASSES[name as keyof typeof TOOL_CLASSES];
  if (!known) throw new Error("Unclassified builtin tool");
  return known;
}

export function toolChangesState(name: string, viaConnector: boolean): boolean {
  const { sideEffectClass } = toolEvidenceClass(name, viaConnector);
  return sideEffectClass !== "none" && sideEffectClass !== "network_read";
}
