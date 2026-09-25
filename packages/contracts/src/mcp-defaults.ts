/** Shipped suggestions; loading this list never connects or grants tools to a bot. */
export const DEFAULT_MCP_SERVERS = [
  {
    id: "context7",
    name: "Context7",
    endpoint: "https://mcp.context7.com/mcp",
    docsUrl: "https://context7.com/docs/resources/all-clients",
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    endpoint: "https://mcp.deepwiki.com/mcp",
    docsUrl: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
  },
] as const;
