import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const surfaceRoots = [
  "apps/web/src",
  "apps/mobile/app",
  "apps/mobile/lib",
  "apps/mobile/components",
  "apps/desktop/src",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(name);
    if (!/\.(tsx?|jsx?|html|po)$/.test(entry.name) || /\.test\.|\.spec\./.test(entry.name)) {
      return [];
    }
    return [name];
  });
}

it("uses the current product name in web, mobile and desktop source", () => {
  const stale = surfaceRoots.flatMap((root) =>
    sourceFiles(join(repoRoot, root))
      .filter((file) => file !== fileURLToPath(import.meta.url))
      .filter((file) => !file.endsWith("apps/desktop/src/user-data-path.ts"))
      .filter((file) => readFileSync(file, "utf8").includes("Ardur Bot"))
      .map((file) => relative(repoRoot, file)),
  );
  expect(stale).toEqual([]);
});
