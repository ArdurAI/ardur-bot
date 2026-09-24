import { describe, expect, it } from "vitest";
import { CustomizationCatalogSchema, LocalServerConfigSchema } from "./customization.js";
import catalog from "./customization-catalog.json" with { type: "json" };

describe("shipped customization contracts", () => {
  it("validates the offline catalog and requires categories and a supported manifest version", () => {
    expect(CustomizationCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(CustomizationCatalogSchema.safeParse({ ...catalog, version: 2 }).success).toBe(false);
    expect(
      CustomizationCatalogSchema.safeParse({
        ...catalog,
        skills: [{ id: "fixture", name: "Fixture", description: "Recipe" }],
      }).success,
    ).toBe(false);
  });
  it("restricts editable configuration to named local servers with typed launch fields", () => {
    expect(
      LocalServerConfigSchema.safeParse({
        mcpServers: { fixture: { name: "Fixture", command: "node", args: ["server.js"], env: {} } },
      }).success,
    ).toBe(true);
    for (const server of [
      { name: "Fixture", command: "" },
      { name: "Fixture", command: "node", args: "server.js" },
      { name: "Fixture", command: "node", env: { TOKEN: 2 } },
      { name: "Fixture", transport: "streamable_http", endpoint: "https://example.test/mcp" },
    ])
      expect(LocalServerConfigSchema.safeParse({ mcpServers: { fixture: server } }).success).toBe(
        false,
      );
  });
});
