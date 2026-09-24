import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
// Whole-repository disk scans need a separate budget from individual unit tests.
const repositoryScanTimeoutMs = 120_000;
// Assemble the search terms so this test does not exempt itself from the scan.
const forbidden = [
  ["pi-anthropic", "oauth"].join("-"),
  ["9d1c250a", "e61b", "44d9", "88ed", "5944d1962f5e"].join("-"),
  ["claude.ai", "oauth"].join("/"),
  ["platform.claude.com", "v1", "oauth"].join("/"),
  [".claude", ".credentials.json"].join("/"),
  ["Claude Code", "credentials"].join("-"),
];
const allowedHistory = (path: string) => path === "NOTICE" || path.startsWith("docs/decisions/");

function hasForbiddenReference(path: string, contents: string): boolean {
  return (
    !allowedHistory(path) &&
    forbidden.some((term) => path.includes(term) || contents.includes(term))
  );
}

function violations(paths: string[]): string[] {
  return paths.filter((path) => {
    if (allowedHistory(path)) return false;
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) return false; // Uncommitted deletions are absent from the build.
    const contents = lstatSync(absolute).isSymbolicLink()
      ? readlinkSync(absolute)
      : readFileSync(absolute, "utf8");
    return hasForbiddenReference(path, contents);
  });
}

const ignoreRules = readFileSync(resolve(root, ".dockerignore"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

function ignored(path: string): boolean {
  return ignoreRules.some((rule) => matchesGlob(path, rule));
}

function contextFiles(directory = ""): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (ignored(path)) return [];
    return entry.isDirectory() ? contextFiles(path) : [path];
  });
}

describe("subscription credential boundary", () => {
  it(
    "keeps removed OAuth and native credential access out of tracked source",
    () => {
      const paths = execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        {
          cwd: root,
          encoding: "utf8",
        },
      )
        .split("\0")
        .filter(Boolean);
      expect(violations([...new Set(paths)])).toEqual([]);
    },
    repositoryScanTimeoutMs,
  );

  it(
    "keeps the server image source context free of removed OAuth and native credential access",
    () => {
      // Includes untracked and gitignored files Docker would copy, excluding only Docker ignores.
      expect(violations(contextFiles())).toEqual([]);
    },
    repositoryScanTimeoutMs,
  );

  it("requires review if the server Dockerfile or ignore rules change the scanned context", () => {
    const dockerfile = readFileSync(resolve(root, "infra/compose/Dockerfile"), "utf8");
    expect(dockerfile.split(/\r?\n/).filter((line) => /^\s*(COPY|ADD)\s/i.test(line))).toEqual([
      "COPY --chmod=755 . .",
    ]);
    expect(existsSync(resolve(root, "infra/compose/Dockerfile.dockerignore"))).toBe(false);
    // Lock the supported ignore syntax and exclusions. Source is scanned independently above,
    // so excluding a restored implementation from Docker cannot conceal it from this guard.
    expect(ignoreRules).toEqual([
      ".git",
      ".beads",
      ".github",
      ".vercel",
      ".turbo",
      ".cache",
      ".DS_Store",
      ".env",
      ".env.*",
      "node_modules",
      "**/node_modules",
      "**/dist",
      "**/build",
      "**/out",
      "**/.expo",
      "**/.astro",
      "coverage",
      "data",
      "artifacts",
      "backups",
      "design",
      "PRODUCT_PLAN.md",
      "playwright-report",
      "test-results",
      "verify-report",
      "*.log",
    ]);
    expect(ignored("packages/adapters/src/restored-login.ts")).toBe(false);
    expect(ignored("apps/api/src/router.ts")).toBe(false);
    expect(ignored("packages/adapters/node_modules")).toBe(true);
  });

  it("detects every forbidden marker and limits historical exceptions to decisions and NOTICE", () => {
    for (const term of forbidden) {
      expect(hasForbiddenReference("packages/adapters/src/restored.ts", `fetch('${term}')`)).toBe(
        true,
      );
      expect(hasForbiddenReference(`${term}.ts`, "")).toBe(true);
      expect(hasForbiddenReference("docs/decisions/history.md", term)).toBe(false);
      expect(hasForbiddenReference("NOTICE", term)).toBe(false);
      expect(hasForbiddenReference("docs/other.md", term)).toBe(true);
      expect(hasForbiddenReference("apps/api/src/NOTICE.ts", term)).toBe(true);
    }
  });
});
