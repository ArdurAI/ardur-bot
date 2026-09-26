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

  it("resolves every runtime workspace import to JavaScript", () => {
    expect(runtimeTypeScriptImports(path.join(__dirname))).toEqual([]);
  });
});

const NODE_CONDITIONS = ["node", "import", "default"];

function runtimeTypeScriptImports(desktopSrc: string): string[] {
  const offenders: string[] = [];
  const seen = new Set<string>();
  const pending = mainProcessSources().map((file) => path.join(desktopSrc, file));
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of valueImportSpecifiers(source)) {
      if (specifier.startsWith("node:") || specifier.startsWith(".")) continue;
      if (!specifier.startsWith("@ardurbot/")) continue;
      const resolved = resolveWorkspaceSpecifier(specifier);
      if (!resolved) continue;
      if (resolved.endsWith(".ts")) {
        offenders.push(`${path.basename(file)}: ${specifier} -> ${resolved}`);
        continue;
      }
      if (resolved.endsWith(".js") && resolved.includes(`${path.sep}packages${path.sep}`)) {
        pending.push(resolved);
      }
    }
  }
  return offenders;
}

function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /(?:^|\n)\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["']/g,
  )) {
    specifiers.push(match[1]!);
  }
  for (const match of source.matchAll(
    /(?:^|\n)\s*export\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["']/g,
  )) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function resolveWorkspaceSpecifier(specifier: string): string | null {
  const slash = specifier.indexOf("/", specifier.startsWith("@") ? specifier.indexOf("/") + 1 : 0);
  const name = slash === -1 ? specifier : specifier.slice(0, slash);
  const subpath = slash === -1 ? "." : `.${specifier.slice(slash)}`;
  const target = resolveWorkspaceExport(name, subpath);
  if (!target) return null;
  const pkgDir = path.join(__dirname, "../../../packages", name.slice("@ardurbot/".length));
  return path.normalize(path.join(pkgDir, target));
}

function resolveWorkspaceExport(name: string, subpath: string): string {
  const pkgDir = path.join(__dirname, "../../../packages", name.slice("@ardurbot/".length));
  const manifest = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
    exports?: Record<string, unknown> | string;
  };
  const exportsField = manifest.exports;
  if (!exportsField || typeof exportsField === "string") return exportsField ?? "";
  return resolveExportTarget(exportsField[subpath]) ?? "";
}

function resolveExportTarget(target: unknown): string | null {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object") return null;
  const record = target as Record<string, unknown>;
  for (const condition of NODE_CONDITIONS) {
    if (condition in record) return resolveExportTarget(record[condition]);
  }
  return null;
}
