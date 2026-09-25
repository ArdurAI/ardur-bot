import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps Board, Fleet, IDE, editor, diff and terminal session out of the initial import graph", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const contracts = path.resolve(root, "../../../packages/contracts/src");
  const visit = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? visit(path.join(directory, entry.name))
        : /\.[jt]sx?$/.test(entry.name)
          ? [path.join(directory, entry.name)]
          : [],
    );
  const sources = new Map(
    [...visit(root), ...visit(contracts)]
      .filter((file) => !file.includes(".test."))
      .map((file) => [file, readFileSync(file, "utf8")]),
  );
  const imports = (source: string) =>
    [
      ...source.matchAll(
        /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/g,
      ),
    ].map((match) => match[1]!);
  const users = [...sources]
    .filter(([, source]) => imports(source).some((name) => name.startsWith("@codemirror/")))
    .map(([file]) => path.relative(root, file));
  expect(users).toEqual(["pages/ide/editor.tsx"]);
  const seen = new Set<string>();
  function walk(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const name of imports(sources.get(file) ?? "")) {
      expect(name.startsWith("@codemirror/")).toBe(false);
      const base =
        name === "@ardurbot/contracts"
          ? path.join(contracts, "index")
          : name.startsWith("@ardurbot/contracts/")
            ? path.join(contracts, name.slice("@ardurbot/contracts/".length))
            : name.startsWith(".")
              ? path.resolve(path.dirname(file), name.replace(/\.js$/, ""))
              : null;
      if (!base) continue;
      const target = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(
        (candidate) => sources.has(candidate),
      );
      if (target) walk(target);
    }
  }
  walk(path.join(root, "main.tsx"));
  for (const file of [
    "pages/board/Board.tsx",
    "pages/board/Graph.tsx",
    "pages/board/ItemForm.tsx",
    "pages/fleet/FleetSettings.tsx",
    "pages/fleet/PlacementNotice.tsx",
    "pages/ide/IdePage.tsx",
    "pages/ide/editor.tsx",
    "pages/ide/unsaved.ts",
    "pages/ide/diff.tsx",
    "pages/ide/terminal.tsx",
    "pages/shell/terminal-session.tsx",
  ])
    expect(seen.has(path.join(root, file)), file).toBe(false);
  for (const file of ["board.ts", "fleet-bridge.ts", "host-bridge.ts", "rpc.ts"])
    expect(seen.has(path.join(contracts, file)), file).toBe(false);
  expect(sources.get(path.join(root, "main.tsx"))).toContain("<BrowserRouter>");
  expect(sources.get(path.join(root, "main.tsx"))).not.toMatch(
    /createBrowserRouter|RouterProvider/,
  );
  for (const source of sources.values()) {
    expect(source).not.toMatch(/\buseBlocker\b/);
    expect(imports(source).some((name) => name.includes("ide-files"))).toBe(false);
  }
  expect(sources.get(path.join(root, "App.tsx"))).toContain(
    'lazy(() => import("./pages/ide/IdePage"))',
  );
});
