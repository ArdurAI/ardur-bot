import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard: no child process Ardur starts may discard its output. Every
 * `stderr.resume()` drain and every `stdio: "ignore"` must either live in
 * child-output.ts (the one capture helper) or be on the allow list below
 * with a reason. Test files are excluded: they use minimal fake children.
 */

const SOURCE_ROOT = fileURLToPath(new URL(".", import.meta.url));

const DISCARD_PATTERNS = [
  { kind: "stderr.resume()", regex: /stderr\.resume\(\)/ },
  { kind: 'stdio: "ignore"', regex: /["'`]?stdio["'`]?\s*:\s*["'`]ignore["'`]/g },
  {
    kind: "ignored stdio array stream",
    regex: /["'`]?stdio["'`]?\s*:\s*\[[^\]]*["'`]ignore["'`][^\]]*\]/g,
  },
] as const;

/** File (relative to src/) -> why this site may keep ignoring a stream. */
const ALLOW_LIST: Record<string, string> = {
  "desktop-sandbox.ts":
    "taskkill helper: a detached one-shot process-tree killer owns no output, so its stdio stays ignored",
  "runtimes/native-process.ts":
    "taskkill helper: a detached one-shot process-tree killer owns no output, so its stdio stays ignored",
  "runtimes/hermes-installer.ts":
    "only stdin is ignored because installer commands read nothing; stdout and stderr are captured into bounded buffers",
};

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (entry === "child-output.ts") continue; // the capture helper itself
    if (!entry.endsWith(".ts") && !entry.endsWith(".mjs")) continue;
    if (entry.endsWith(".test.ts")) continue;
    yield full;
  }
}

function discardHits(root: string) {
  const hits: { file: string; line: number; kind: string; text: string }[] = [];
  for (const file of sourceFiles(root)) {
    const rel = relative(root, file).split("\\").join("/");
    const text = readFileSync(file, "utf8");
    for (const pattern of DISCARD_PATTERNS) {
      for (const match of text.matchAll(new RegExp(pattern.regex.source, "g"))) {
        hits.push({
          file: rel,
          line: text.slice(0, match.index).split("\n").length,
          kind: pattern.kind,
          text: match[0],
        });
      }
    }
  }
  return hits;
}

describe("child output discard guard", () => {
  it.each([
    'stdio: ["pipe", "ignore", "ignore"]',
    "stdio: ['pipe', 'pipe', 'ignore']",
    'stdio: [\n  "pipe",\n  "ignore",\n  "pipe"\n]',
    '"stdio": "ignore"',
    "stdio: 'ignore'",
  ])("rejects a discarded stream in a scratch source: %s", (stdio) => {
    const root = mkdtempSync(join(tmpdir(), "child-output-guard-"));
    try {
      writeFileSync(join(root, "scratch.ts"), `spawn("fixture", [], { ${stdio} });\n`);
      const unlisted = discardHits(root).filter((hit) => !(hit.file in ALLOW_LIST));
      expect(unlisted).toHaveLength(1);
      expect(unlisted[0]?.file).toBe("scratch.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("every discarded stream is either captured or allow-listed with a reason", () => {
    const hits = discardHits(SOURCE_ROOT);
    const unlisted = hits.filter((hit) => !(hit.file in ALLOW_LIST));
    expect(
      unlisted.map(
        (hit) => `${hit.file}:${hit.line} discards output via ${hit.kind} (${hit.text})`,
      ),
    ).toEqual([]);
  });

  it("every allow-list entry still matches a real site", () => {
    const filesWithHits = new Set<string>();
    for (const hit of discardHits(SOURCE_ROOT)) filesWithHits.add(hit.file);
    const stale = Object.keys(ALLOW_LIST).filter((file) => !filesWithHits.has(file));
    expect(stale).toEqual([]);
  });
});
