import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The packaged app runs the compiled JS in dist/ against the workspace packages copied into
 * app.asar as-is. @ardurbot/contracts ships TypeScript source, so a runtime import of its root
 * entry loads a .ts file inside Electron and the app dies at startup with a "JavaScript error
 * in the main process" dialog before it can even print --version. Only type-only imports of the
 * root entry are safe; runtime values must come from a subpath that points at a .js file.
 */
const contractsPackage = JSON.parse(
  readFileSync(path.join(__dirname, "../../../packages/contracts/package.json"), "utf8"),
) as { exports: Record<string, string | Record<string, string>> };

function runtimeSafeSubpaths() {
  return Object.entries(contractsPackage.exports)
    .filter(([, target]) => typeof target === "string" && target.endsWith(".js"))
    .map(([subpath]) => subpath.replace(/^\.\//, ""));
}

function mainProcessSources() {
  return readdirSync(__dirname).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts"),
  );
}

describe("packaged main-process imports", () => {
  it("never imports runtime values from the TypeScript-only contracts entry", () => {
    const offenders: string[] = [];
    for (const file of mainProcessSources()) {
      const source = readFileSync(path.join(__dirname, file), "utf8");
      for (const match of source.matchAll(
        /^import\s+(?!type\s)[^;]*?from\s+"@ardurbot\/contracts(\/[^"]*)?"/gm,
      )) {
        const subpath = match[1]?.slice(1);
        if (!subpath || !runtimeSafeSubpaths().includes(subpath)) {
          offenders.push(`${file}: ${match[0].split("\n").join(" ")}`);
        }
      }
    }
    expect(offenders, "move the value into a .js subpath export (see device-paths.js)").toEqual([]);
  });

  it("keeps the device path helpers on a JavaScript subpath", () => {
    expect(contractsPackage.exports["./device-paths"]).toBe("./src/device-paths.js");
  });
});
