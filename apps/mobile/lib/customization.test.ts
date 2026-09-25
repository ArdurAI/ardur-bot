import { DEFAULT_MCP_SERVERS } from "@ardurbot/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  View: ({ children }: { children: unknown }) => createElement("div", null, children as never),
  Text: ({ children }: { children: unknown }) => createElement("span", null, children as never),
  ScrollView: ({ children }: { children: unknown }) =>
    createElement("div", null, children as never),
  ActivityIndicator: () => createElement("span"),
  Pressable: () => createElement("button", { type: "button" }),
  TextInput: () => createElement("input"),
}));
vi.mock("expo-router", () => ({ Stack: { Screen: () => null } }));
vi.mock("../lib/api", () => ({ rpc: vi.fn() }));
vi.mock("../lib/i18n", () => ({
  useI18n: () => ({
    t: (value: string, params: Record<string, string> = {}) =>
      value.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? key),
  }),
}));
vi.mock("../lib/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../lib/native", () => ({ useThemedStyles: (factory: () => unknown) => factory() }));

import { CustomizationRows } from "../components/customization-list";
import { loadCustomization } from "./customization";

describe("mobile customization lists", () => {
  it("renders user, marketplace, learned and taught provenance without claiming false authorship", async () => {
    const skills = await loadCustomization("skills", async () =>
      [
        { kind: "file", source: "user" },
        { kind: "file", source: "plugin" },
        { kind: "learned", source: "learned" },
        { kind: "taught", source: "user" },
        { kind: "file", source: "imported" },
      ].map((value, i) => ({
        ...value,
        id: String(i),
        name: `Skill ${i}`,
        description: "Recipe",
        enabled: true,
        botId: null,
        pluginId: value.source === "plugin" ? "plugin" : null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      })),
    );
    const plugins = await loadCustomization("plugins", async () => ({
      installs: [
        {
          id: "plugin",
          name: "Fixture plugin",
          description: "Review",
          author: "Fixture publisher",
          source: "marketplace",
          state: "installed",
          marketplaceId: "market",
          version: null,
          categories: [],
          skills: [],
          commands: [],
          servers: [],
          instructions: [],
          createdAt: new Date(0).toISOString(),
        },
      ],
    }));
    const render = (rows: typeof skills) =>
      renderToStaticMarkup(createElement(CustomizationRows, { rows }));
    expect(render([skills[0]!])).toContain("by you");
    for (const row of [...skills.slice(1), ...plugins])
      expect(render([row])).not.toContain("by you");
    expect(render([skills[1]!])).toContain("From a plugin");
    expect(render([skills[2]!])).toContain("Learned skill");
    expect(render([skills[3]!])).toContain("Taught skill");
    expect(render(plugins)).toContain("Fixture publisher");
  });
  it("separates product accounts from local MCP and includes opt-in defaults without mutations", async () => {
    const server = {
      name: "Fixture",
      slug: "fixture",
      spaceId: "space",
      description: "",
      transport: "stdio",
      command: "node",
      endpoint: null,
      args: [],
      envKeys: [],
      headerKeys: [],
      hasSecret: false,
      enabled: true,
      revision: 1,
      oauthStatus: "none",
      createdAt: "",
      updatedAt: "",
    };
    const request = vi.fn(async (procedure: string) =>
      procedure === "integrations/list"
        ? { catalog: [], connections: [] }
        : [
            { ...server, id: "product", catalogId: "github" },
            { ...server, id: "local" },
            {
              ...server,
              id: "default",
              transport: "streamable_http",
              endpoint: DEFAULT_MCP_SERVERS[0].endpoint,
            },
          ],
    );
    expect((await loadCustomization("integrations", request)).map((row) => row.id)).toEqual([
      "product",
    ]);
    const rows = await loadCustomization("mcp", request);
    expect(rows.map((row) => row.id)).toEqual(["local", "default", "default:deepwiki"]);
    expect(rows[0]).toMatchObject({ detail: "Desktop", badges: ["Custom", "Local dev"] });
    expect(rows[1]?.badges).toEqual(["Included"]);
    expect(rows[2]).toMatchObject({
      name: "DeepWiki",
      status: "disconnected",
      badges: ["Included"],
    });
    expect(new Set(request.mock.calls.map(([procedure]) => procedure))).toEqual(
      new Set(["integrations/list", "mcp/servers/list"]),
    );
  });
  it("renders read-only skill, plugin and reconnection rows without mutation controls", () => {
    const html = renderToStaticMarkup(
      createElement(CustomizationRows, {
        rows: [
          {
            id: "skill",
            name: "Fixture skill",
            description: "Fixture recipe",
            detail: "File skill",
            badges: ["Disabled"],
          },
          {
            id: "plugin",
            name: "Fixture plugin",
            description: "Review",
            detail: "From the catalog",
            badges: ["Review"],
          },
          {
            id: "connector",
            name: "Fixture connector",
            description: "",
            detail: "Desktop",
            status: "reconnect",
            badges: ["Custom", "Local dev"],
          },
        ],
      }),
    );
    for (const text of [
      "Fixture skill",
      "Fixture plugin",
      "Fixture connector",
      "Needs reconnection",
      "Local dev",
      "Disabled",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });
  it("loads all three skill kinds through a list-only procedure", async () => {
    const request = vi.fn(async () =>
      ["file", "taught", "learned"].map((kind) => ({
        id: kind,
        name: kind,
        description: "Fixture",
        source: "user",
        kind,
        enabled: true,
        botId: null,
        pluginId: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      })),
    );
    expect((await loadCustomization("skills", request)).map((row) => row.detail)).toEqual([
      "File skill",
      "Taught skill",
      "Learned skill",
    ]);
    expect(request).toHaveBeenCalledExactlyOnceWith("customizationSkills/list");
    await expect(loadCustomization("skills", async () => [{ name: "invalid" }])).rejects.toThrow();
  });
});
