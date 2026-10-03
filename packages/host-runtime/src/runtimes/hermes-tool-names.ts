/** Pinned tools/mcp_tool.py: sanitize_mcp_name_component + mcp_prefixed_tool_name. */
export function hermesToolName(name: string): string {
  return `mcp__ardur__${name.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** A lossy wire name must never select between two tools with different consent. */
export function hermesToolNames(tools: "none" | readonly { name: string }[]): string[] {
  const names =
    tools === "none"
      ? []
      : tools
          .filter((tool) => tool.name !== "run_subagent")
          .map((tool) => hermesToolName(tool.name));
  if (new Set(names).size !== names.length) throw new Error("Hermes tool names collide.");
  return names.sort();
}
