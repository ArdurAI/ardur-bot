// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Bundle fixtures contain literal protocol placeholders.
import { describe, expect, it } from "vitest";
import type { BundleFile } from "./files.js";
import {
  parseMarketplace,
  parsePluginManifest,
  parsePluginServers,
  planPlugin,
  pluginFiles,
  pluginInstallFiles,
} from "./plugins.js";

const file = (path: string, content: string | object): BundleFile => ({
  path,
  bytes: Buffer.from(typeof content === "string" ? content : JSON.stringify(content)),
});
const marketplace = () => ({
  name: "fixture-market",
  owner: { name: "Fixture publisher" },
  plugins: [{ name: "fixture-plugin", source: "./plugins/fixture", category: "Development" }],
});
const skill = "---\nname: fixture\ndescription: Fixture recipe\n---\nReview the input.";

describe("open plugin format", () => {
  it("parses official marketplace fields, relative and Git sources", () => {
    expect(parseMarketplace(marketplace()).plugins[0]).toMatchObject({
      name: "fixture-plugin",
      source: "plugins/fixture",
      strict: true,
      category: "Development",
    });
    expect(
      parseMarketplace({
        ...marketplace(),
        plugins: [
          { name: "fixture", source: { source: "github", repo: "fixture/plugin", ref: "v1.0.0" } },
        ],
      }).plugins[0]?.source,
    ).toMatchObject({ source: "github", repo: "fixture/plugin" });
    expect(
      parseMarketplace({
        ...marketplace(),
        plugins: [
          { name: "fixture", source: { source: "url", url: "https://example.test/plugin.git" } },
        ],
      }).plugins,
    ).toHaveLength(1);
  });
  it("validates required metadata and refuses traversal, credential URLs and ambiguous names", () => {
    expect(() => parseMarketplace({ ...marketplace(), owner: {} })).toThrow();
    expect(() =>
      parseMarketplace({ ...marketplace(), plugins: [{ name: "fixture", source: "../outside" }] }),
    ).toThrow();
    expect(() =>
      parseMarketplace({
        ...marketplace(),
        plugins: [
          {
            name: "fixture",
            source: { source: "url", url: "https://user:token@example.test/plugin.git" },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseMarketplace({
        ...marketplace(),
        plugins: [...marketplace().plugins, ...marketplace().plugins],
      }),
    ).toThrow("repeats");
    expect(() => parsePluginManifest({ name: "invalid name" })).toThrow();
    expect(() => parsePluginManifest({ name: "fixture", skills: "./../outside" })).toThrow();
  });
  it("summarizes every supported component before installation, binding consent to file contents", () => {
    const files = [
      file(".claude-plugin/plugin.json", {
        name: "fixture",
        version: "1.0.0",
        mcpServers: {
          local: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"], env: {} },
        },
      }),
      file("skills/review/SKILL.md", skill),
      file("commands/check.md", "Check the input."),
      file("output-styles/brief.md", "Write short responses."),
      file("server.js", "fixture"),
      file("CLAUDE.md", "Not automatically loaded by the official format."),
    ];
    const plan = planPlugin(files);
    expect(plan.skills.map((entry) => entry.path)).toEqual(["skills/review/SKILL.md"]);
    expect(plan.commands.map((entry) => entry.path)).toEqual(["commands/check.md"]);
    expect(plan.instructions.map((entry) => entry.path)).toEqual(["output-styles/brief.md"]);
    expect(Object.keys(plan.servers)).toEqual(["local"]);
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(planPlugin([...files.slice(0, -1), file("CLAUDE.md", "Changed")]).digest).not.toBe(
      plan.digest,
    );
  });
  it("adds skill paths, replaces command paths, loads .mcp.json and ignores unknown metadata", () => {
    const plan = planPlugin([
      file(".claude-plugin/plugin.json", {
        name: "fixture",
        skills: "./extra/",
        commands: ["./custom.md"],
        futureMetadata: { harmless: true },
      }),
      file("skills/a/SKILL.md", skill),
      file("extra/b/SKILL.md", skill),
      file("commands/ignored.md", "Ignored"),
      file("custom.md", "Custom command"),
      file(".mcp.json", {
        mcpServers: { remote: { type: "http", url: "https://example.test/mcp" } },
      }),
    ]);
    expect(plan.skills).toHaveLength(2);
    expect(plan.commands.map((entry) => entry.path)).toEqual(["custom.md"]);
    expect(plan.servers.remote?.type).toBe("http");
  });
  it("accepts strict:false entry definitions and refuses competing component definitions", () => {
    const entry = parseMarketplace({
      ...marketplace(),
      plugins: [{ name: "fixture", source: "./", strict: false, commands: ["./command.md"] }],
    }).plugins[0]!;
    expect(planPlugin([file("command.md", "Recipe")], entry).commands).toHaveLength(1);
    expect(() =>
      planPlugin(
        [
          file(".claude-plugin/plugin.json", { name: "fixture", commands: "./commands/" }),
          file("command.md", "Recipe"),
        ],
        entry,
      ),
    ).toThrow("conflicting");
  });
  it("refuses unimplemented executable components instead of silently installing part of a plugin", () => {
    expect(() =>
      planPlugin([file(".claude-plugin/plugin.json", { name: "fixture", hooks: "./hooks.json" })]),
    ).toThrow("not supported");
    expect(() =>
      planPlugin([
        file(".claude-plugin/plugin.json", { name: "fixture" }),
        file("hooks/hooks.json", {}),
      ]),
    ).toThrow("not supported");
    expect(() => parsePluginServers({ remote: { type: "http", command: "node" } })).toThrow("URL");
    expect(() => parsePluginServers({ remote: { url: "http://example.test/mcp" } })).toThrow(
      "HTTPS",
    );
  });
  it("takes only the selected relative plugin from a marketplace snapshot", () => {
    const files = [
      file("plugins/fixture/commands/a.md", "Fixture"),
      file("plugins/another/private.md", "Another"),
    ];
    expect(pluginFiles(files, "plugins/fixture").map((entry) => entry.path)).toEqual([
      "commands/a.md",
    ]);
    expect(() => pluginFiles(files, "../outside")).toThrow();
  });
  it("removes launch credentials from every configuration file written during installation", () => {
    const files = [
      file(".claude-plugin/plugin.json", { name: "fixture", mcpServers: "./config/mcp.json" }),
      file("config/mcp.json", {
        fixture: {
          command: "node",
          args: ["--token", "fixture-private-value"],
          env: { TOKEN: "fixture-private-value" },
        },
      }),
      file("commands/review.md", "Review input."),
    ];
    const plan = planPlugin(files);
    expect(plan.servers.fixture?.env?.TOKEN).toBe("fixture-private-value");
    const installed = pluginInstallFiles(files, plan);
    expect(installed.map((entry) => Buffer.from(entry.bytes).toString()).join("\n")).not.toContain(
      "fixture-private-value",
    );
    expect(installed.find((entry) => entry.path === "commands/review.md")?.bytes).toEqual(
      files[2]!.bytes,
    );
  });
});
