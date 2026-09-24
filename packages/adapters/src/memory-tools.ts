import type { ConnectorTool } from "@ardurbot/adapter-kit";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory", "forget_memory"]);

export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}
