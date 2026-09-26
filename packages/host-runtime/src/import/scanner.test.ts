import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LOCAL_IMPORT_BYTES, LOCAL_IMPORT_ITEMS } from "@ardurbot/contracts/local-import";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseToml, safeText, serverDefinition } from "./formats.js";
import { LocalImportScanner, localImportDefaults } from "./scanner.js";

let home: string;
async function file(relative: string, content: string) {
  const target = path.join(home, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
const skill = "---\nname: review\ndescription: Review a change\n---\nRead the patch.";
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "local-import-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("local import discovery", () => {
  it("finds every tool, counts categories and returns only metadata until read", async () => {
    await file(".claude/CLAUDE.md", "Use small changes.");
    await file(".claude/projects/project/memory/MEMORY.md", "Project facts.");
    await file(
      ".claude/projects/project/memory/topic.md",
      "---\nname: build\ndescription: Build process\ntype: project\n---\nRun offline.",
    );
    await file(".claude/skills/review/SKILL.md", skill);
    await file(
      ".claude/settings.json",
      JSON.stringify({
        mcpServers: {
          search: {
            command: "node",
            args: ["server.js"],
            env: { API_KEY: "fixture-private-value", MODE: "also-private" },
          },
        },
      }),
    );
    await file(
      ".claude/plugins/installed_plugins.json",
      '{"version":2,"plugins":{"sample@market":[]}}',
    );
    await file(
      ".claude/plugins/marketplaces/sample/plugins/one/.claude-plugin/plugin.json",
      '{"name":"one"}',
    );
    await file(".codex/AGENTS.md", "Check the result.");
    await file(".codex/skills/review/SKILL.md", skill);
    await file(
      ".codex/config.toml",
      'developer_instructions = "Be precise."\n[mcp_servers.search]\ncommand = "node"\nargs = ["search.js"]\n[mcp_servers.search.env]\nTOKEN = "fixture-private-value"\n',
    );
    await file(
      ".kimi/mcp.json",
      '{"mcpServers":{"kimi-search":{"url":"https://example.invalid/mcp"}}}',
    );
    await file(".kimi/plans/todo.md", "Plan body.");
    await file(".cursor/rules/change.mdc", "---\nalwaysApply: true\n---\nExplain the change.");
    await file(".cursor/skills/review/SKILL.md", skill);
    await file(".cursor/skills-cursor/other/SKILL.md", skill.replace("review", "other"));
    await file(".cursor/agents/helper.md", "Agent body.");
    await file(".cursor/hooks.json", '{"commands":["must never run"]}');
    await file(".gemini/GEMINI.md", "Use sources.");
    await file(
      ".gemini/settings.json",
      '{"mcpServers":{"gemini-search":{"httpUrl":"https://example.invalid/mcp"}}}',
    );
    await file(".hermes/SOUL.md", "Be helpful.");
    await file(
      ".hermes/config.yaml",
      "model:\n  provider: local\n  default: sample-model\napi_key: fixture-private-value\n",
    );
    await file(
      "Library/Application Support/Claude/Claude Extensions/sample/manifest.json",
      '{"manifest_version":"0.3","name":"sample","server":{"mcp_config":{"command":"node","args":["server.js"]}}}',
    );
    await file("projects/example/AGENTS.md", "Project rule.");
    const scanner = new LocalImportScanner({
      home,
      platform: "darwin",
      registeredFolders: [path.join(home, "projects/example")],
    });
    const scan = await scanner.scan();
    expect(scan.sources.filter((source) => source.detected)).toHaveLength(7);
    expect(scan.sources[0]).toMatchObject({
      counts: { instructions: 1, memories: 2, skills: 1, servers: 1, plugins: 2 },
      memoryFolders: 1,
    });
    expect(JSON.stringify(scan)).not.toContain("Use small changes.");
    expect(JSON.stringify(scan)).not.toContain("fixture-private-value");
    expect(JSON.stringify(scan)).not.toContain(home);
    const server = scan.items.find(
      (item) => item.tool === "claude-code" && item.category === "servers",
    )!;
    expect(scanner.read(scan.scanId, server.id).server?.envNames).toEqual(["API_KEY", "MODE"]);
    for (const item of scan.items.filter((item) => item.importable))
      expect(JSON.stringify(scanner.read(scan.scanId, item.id))).not.toMatch(
        /fixture-private-value|also-private/,
      );
    expect(scan.items.find((item) => item.tool === "claude-desktop")?.reason).toContain(
      "not yet importable",
    );
    expect(
      scan.items.find((item) => item.tool === "hermes" && item.category === "other")?.name,
    ).toBe("local / sample-model");
  });

  it("excludes credentials, histories, caches, backups and escaping symlinks", async () => {
    for (const excluded of [
      "auth.json",
      "credentials",
      ".credentials.json",
      ".credentials.md",
      "oauth_creds.json",
      "oauth-token.md",
      "cookies",
      "tokens",
      "secret.bak",
      "history.jsonl",
      "telemetry/a.md",
      "cache/a.md",
      "sessions/a.md",
      "session-transcript.md",
      "user-history/a.md",
      "transcripts/a.md",
      "chat/a.md",
    ])
      await file(`.claude/projects/project/memory/${excluded}`, "fixture-private-value");
    await file(
      ".claude/projects/project/memory/valid.md",
      "password=fixture-private-value\nKeep the useful fact.",
    );
    const outside = await mkdtemp(path.join(tmpdir(), "outside-import-"));
    try {
      await writeFile(path.join(outside, "private.md"), "fixture-private-value");
      await symlink(path.join(outside, "private.md"), path.join(home, ".claude/CLAUDE.md"));
      const scanner = new LocalImportScanner({ home });
      const scan = await scanner.scan();
      expect(scan.items).toHaveLength(1);
      expect(scanner.read(scan.scanId, scan.items[0]!.id).content).toBe(
        "[Redacted]\nKeep the useful fact.",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("allows skill symlinks only within home, and restricts reads to the latest scan", async () => {
    await file("shared/review/SKILL.md", skill);
    await mkdir(path.join(home, ".claude/skills"), { recursive: true });
    await symlink(path.join(home, "shared/review"), path.join(home, ".claude/skills/review"));
    const scanner = new LocalImportScanner({ home });
    const first = await scanner.scan();
    expect(first.items).toHaveLength(1);
    expect(() => scanner.read(first.scanId, "../../auth.json")).toThrow();
    const second = await scanner.scan();
    expect(() => scanner.read(first.scanId, first.items[0]!.id)).toThrow("Re-scan");
    expect(second.items[0]!.contentHash).toBe(first.items[0]!.contentHash);
    expect(scanner.read(second.scanId, second.items[0]!.id).content).toBe(skill);
  });

  it("reports large text and malformed configuration without exposing contents", async () => {
    await file(".claude/CLAUDE.md", "x".repeat(LOCAL_IMPORT_BYTES + 1));
    await file(".codex/config.toml", "[malformed\nsecret = fixture-private-value");
    const scanner = new LocalImportScanner({ home });
    const scan = await scanner.scan();
    expect(scan.limited).toBe(true);
    expect(scan.items).toHaveLength(2);
    for (const item of scan.items) expect(() => scanner.read(scan.scanId, item.id)).toThrow();
    expect(JSON.stringify(scan)).not.toContain("fixture-private-value");
  });

  it("does not count an oversized file that is still listed with a reason", async () => {
    await file(".claude/CLAUDE.md", "x".repeat(LOCAL_IMPORT_BYTES + 1));
    const scan = await new LocalImportScanner({ home }).scan();
    expect(scan.limited).toBe(true);
    // The file was scanned and is listed below, so it must not count as unscanned.
    expect(scan.unscanned).toBeUndefined();
    expect(scan.items).toMatchObject([
      { importable: false, reason: "This item exceeds the import size limit." },
    ]);
  });

  it("keeps a numeric unscanned count even when an oversized item is also listed", async () => {
    await file(".claude/CLAUDE.md", "x".repeat(LOCAL_IMPORT_BYTES + 1));
    const perFolder = Math.ceil(LOCAL_IMPORT_ITEMS / 2) + 4;
    for (const project of ["a", "b"])
      for (let i = 0; i < perFolder; i++)
        await file(`.claude/projects/${project}/memory/note-${i}.md`, "A fact.");
    const scan = await new LocalImportScanner({ home }).scan();
    expect(scan.limited).toBe(true);
    // The oversized CLAUDE.md must not wipe the count of notes the item cap left out.
    expect(scan.unscanned).toBeGreaterThan(0);
  });

  it("does not know how many files a limit left out once it stops before it can count them", async () => {
    await file(".claude/projects/p/memory/a/b/c/d/e/deep.md", "Too deep to reach.");
    const uncounted = await new LocalImportScanner({ home }).scan();
    expect(uncounted.limited).toBe(true);
    expect(uncounted.unscanned).toBeUndefined();
  });

  it("inspects sqlite schemas and selects memory text only", async () => {
    await mkdir(path.join(home, ".codex"));
    const db = new DatabaseSync(path.join(home, ".codex/memories_fixture.sqlite"));
    db.exec(
      "CREATE TABLE memories (content TEXT, token TEXT, transcript TEXT); CREATE TABLE sessions (content TEXT);",
    );
    db.prepare("INSERT INTO memories VALUES (?, ?, ?)").run(
      "Remember the build command.",
      "fixture-private-value",
      "fixture-chat-history",
    );
    db.prepare("INSERT INTO sessions VALUES (?)").run("fixture-chat-history");
    db.close();
    const scanner = new LocalImportScanner({ home });
    const scan = await scanner.scan();
    expect(scan.items).toHaveLength(1);
    expect(scanner.read(scan.scanId, scan.items[0]!.id).content).toBe(
      "Remember the build command.",
    );
  });

  it("uses overrides only when defaults are absent and confines them to home", async () => {
    await file("alternate/AGENTS.md", "Alternate.");
    const scanner = new LocalImportScanner({ home });
    expect((await scanner.scan({ codex: "alternate" })).items).toHaveLength(1);
    await file(".codex/AGENTS.md", "Default.");
    const scan = await scanner.scan({ codex: "alternate" });
    expect(scanner.read(scan.scanId, scan.items[0]!.id).content).toBe("Default.");
  });
  it("does not follow instruction pointers into a credential store or import report-only bodies", async () => {
    await file(".ssh/id_rsa", "fixture-private-value");
    await file(".codex/config.toml", 'model_instructions_file = "../.ssh/id_rsa"');
    await file(".kimi/plans/todo.md", "fixture-private-value");
    await file(".claude/skills/review/SKILL.md", skill);
    await file(".claude/skills/review/scripts/run.sh", "fixture-private-value");
    const scanner = new LocalImportScanner({ home });
    const scan = await scanner.scan();
    expect(scan.items.some((item) => item.relativePath.includes(".ssh"))).toBe(false);
    expect(scan.items.filter((item) => item.category === "other")).toHaveLength(2);
    expect(JSON.stringify(scan)).not.toContain("fixture-private-value");
    for (const item of scan.items.filter((item) => !item.importable))
      expect(() => scanner.read(scan.scanId, item.id)).toThrow();
  });
});

it("maps Windows and Linux defaults without pretending desktop extensions exist on Linux", () => {
  expect(
    localImportDefaults("win32", {
      USERPROFILE: "C:\\Users\\fixture",
      APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
    }).roots.codex,
  ).toBe("C:\\Users\\fixture\\.codex");
  const linux = localImportDefaults("linux", { HOME: "/home/fixture" });
  expect(linux.roots["claude-code"]).toBe("/home/fixture/.claude");
  expect(linux.roots["claude-desktop"]).toBeUndefined();
});
it("parses quoted TOML tables, multiline arrays and inline environment maps", () => {
  expect(
    parseToml(
      '[mcp_servers."local-search"]\ncommand = \'node\'\nargs = [\n "server.js", # comment\n]\nenv = { API_KEY = "discard-me" }\n',
    ),
  ).toMatchObject({
    mcp_servers: {
      "local-search": { command: "node", args: ["server.js"], env: { API_KEY: "discard-me" } },
    },
  });
});
it("refuses credential-bearing URLs and arguments and retains names only", () => {
  expect(serverDefinition("remote", { url: "https://example.invalid/mcp?key=fixture" })).toBeNull();
  expect(serverDefinition("local", { command: "node", args: ["--token", "fixture"] })).toBeNull();
  expect(
    serverDefinition("local", { command: "node", env: { TOKEN: "discard-me" } }),
  ).toMatchObject({ envNames: ["TOKEN"] });
});
it("redacts quoted credential assignments in otherwise eligible Markdown", () => {
  for (const name of [
    "api_key",
    "accessToken",
    "client_secret",
    "password",
    "authorization",
    "private_key",
  ]) {
    expect(safeText(`{"${name}": "fixture-private-value"}\nKeep this fact.`)).not.toContain(
      "fixture-private-value",
    );
  }
});
it("retains bearer variable names and transport differences without copying header values", () => {
  expect(
    serverDefinition("remote", {
      url: "https://example.invalid/mcp",
      bearer_token_env_var: "ACCESS_TOKEN",
      env_http_headers: { "X-Key": "API_KEY" },
    }),
  ).toMatchObject({
    envNames: ["ACCESS_TOKEN", "API_KEY"],
    headerEnv: {
      Authorization: { name: "ACCESS_TOKEN", bearer: true },
      "X-Key": { name: "API_KEY", bearer: false },
    },
  });
  expect(
    serverDefinition("remote", { url: "https://example.invalid/sse" }, "gemini")?.transport,
  ).toBe("sse");
  expect(
    serverDefinition("remote", { httpUrl: "https://example.invalid/mcp" }, "gemini")?.transport,
  ).toBe("streamable_http");
  expect(serverDefinition("local", { command: "node", cwd: "/fixture/working" })).toBeNull();
});
