import { readdirSync, readFileSync, statSync } from "node:fs";
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
  { kind: 'stdio: "ignore"', regex: /stdio:\s*"ignore"/ },
  { kind: 'stdio: ["ignore", ...]', regex: /stdio:\s*\[\s*"ignore"/ },
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

describe("child output discard guard", () => {
  it("every discarded stream is either captured or allow-listed with a reason", () => {
    const hits: { file: string; line: number; kind: string; text: string }[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const rel = relative(SOURCE_ROOT, file).split("\\").join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((text, index) => {
        for (const pattern of DISCARD_PATTERNS) {
          if (pattern.regex.test(text))
            hits.push({ file: rel, line: index + 1, kind: pattern.kind, text: text.trim() });
        }
      });
    }
    const unlisted = hits.filter((hit) => !(hit.file in ALLOW_LIST));
    expect(
      unlisted.map(
        (hit) => `${hit.file}:${hit.line} discards output via ${hit.kind} (${hit.text})`,
      ),
    ).toEqual([]);
  });

  it("every allow-list entry still matches a real site", () => {
    const filesWithHits = new Set<string>();
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const rel = relative(SOURCE_ROOT, file).split("\\").join("/");
      const text = readFileSync(file, "utf8");
      if (DISCARD_PATTERNS.some((pattern) => pattern.regex.test(text))) filesWithHits.add(rel);
    }
    const stale = Object.keys(ALLOW_LIST).filter((file) => !filesWithHits.has(file));
    expect(stale).toEqual([]);
  });
});
