import {
  CustomizationSkillSchema,
  DEFAULT_MCP_SERVERS,
  IntegrationCatalogListSchema,
  McpServerSchema,
  PluginInstallSchema,
} from "@ardurbot/contracts";
import { connectorRows } from "@ardurbot/core";

export type MobileCustomizationKind = "skills" | "integrations" | "mcp" | "plugins";
export type MobileCustomizationRow = {
  id: string;
  name: string;
  description: string;
  detail: string;
  date?: string;
  status?: "connected" | "reconnect" | "disconnected";
  badges: string[];
};
export async function loadCustomization(
  kind: MobileCustomizationKind,
  request: (procedure: string) => Promise<unknown>,
): Promise<MobileCustomizationRow[]> {
  if (kind === "skills")
    return CustomizationSkillSchema.array()
      .parse(await request("customizationSkills/list"))
      .map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        detail:
          row.kind === "learned"
            ? "Learned skill"
            : row.kind === "taught"
              ? "Taught skill"
              : "File skill",
        date: row.createdAt,
        badges: row.enabled ? [] : ["Disabled"],
      }));
  if (kind === "plugins") {
    const raw = (await request("plugins/list")) as { installs: unknown };
    return PluginInstallSchema.array()
      .parse(raw.installs)
      .map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        detail:
          row.source === "catalog"
            ? "From the catalog"
            : row.source === "space"
              ? "In this space"
              : "From marketplaces you added",
        date: row.createdAt,
        badges: row.categories,
      }));
  }
  const [catalog, servers] = await Promise.all([
    request("integrations/list"),
    request("mcp/servers/list"),
  ]);
  const parsedServers = McpServerSchema.array().parse(servers);
  const rows = connectorRows({
    ...IntegrationCatalogListSchema.parse(catalog),
    servers: parsedServers,
  });
  const visible = rows.filter((row) => (kind === "mcp" ? !row.catalogId : Boolean(row.catalogId)));
  if (kind === "mcp")
    for (const preset of DEFAULT_MCP_SERVERS) {
      const installed = parsedServers.find(
        (server) => !server.catalogId && !server.managedBy && server.endpoint === preset.endpoint,
      );
      if (installed) {
        const row = visible.find((row) => row.id === installed.id);
        if (row) row.badges = ["included"];
      } else
        visible.push({
          id: `default:${preset.id}`,
          name: preset.name,
          type: "web",
          badges: ["included"],
          status: "disconnected",
          available: true,
        });
    }
  return visible.map((row) => ({
    id: row.id,
    name: row.name,
    description: "",
    detail: row.type === "web" ? "Web" : "Desktop",
    status: row.status,
    badges: row.badges.map((badge) =>
      badge === "custom" ? "Custom" : badge === "included" ? "Included" : "Local dev",
    ),
  }));
}
