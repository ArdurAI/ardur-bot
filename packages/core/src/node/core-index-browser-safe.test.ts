import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(__dirname, "..");

function resolveLocal(spec: string, fromDir: string): string | undefined {
  const base = spec.replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    const file = path.resolve(fromDir, candidate);
    try {
      readFileSync(file);
      return file;
    } catch {
      // try the next candidate shape
    }
  }
  return undefined;
}

/** Every local file the core index reaches, directly or through re-exports. */
function indexGraph(): string[] {
  const visited = new Set<string>();
  const queue = [path.join(srcDir, "index.ts")];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const spec of readFileSync(file, "utf8").matchAll(/from\s+"(\.\/[^"]+)"/g)) {
      const local = spec[1];
      if (!local) continue;
      const resolved = resolveLocal(local, path.dirname(file));
      if (resolved) queue.push(resolved);
    }
  }
  return [...visited];
}

/**
 * Protects the browser bundle: the web app imports the core index, so a
 * `node:` import anywhere it reaches breaks every browser screen at load
 * time while Node unit tests still pass. Node-only helpers must live behind
 * a `./node/...` subpath export instead.
 */
describe("core index stays browser-safe", () => {
  const files = indexGraph();

  it("actually walks the export graph", () => {
    expect(files.some((file) => file.endsWith("bot-comms-policy.ts"))).toBe(true);
    expect(files.length).toBeGreaterThan(50);
  });

  it("keeps node: imports out of every file the index re-exports", () => {
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.includes('from "node:'))
        .map((line) => `${path.relative(srcDir, file)}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
