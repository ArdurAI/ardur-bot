import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../scripts/stage-embedded-postgres.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakePackage(root: string, name: string, cpu: string) {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  mkdirSync(path.join(dir, "native", "bin"), { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, os: ["darwin"], cpu: [cpu] }),
  );
  writeFileSync(path.join(dir, "native", "bin", "postgres"), "fixture-binary");
}

function fakeDesktop() {
  const root = mkdtempSync(path.join(tmpdir(), "stage-postgres-"));
  roots.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fake-desktop" }));
  fakePackage(root, "@embedded-postgres/darwin-x64", "x64");
  fakePackage(root, "@embedded-postgres/darwin-arm64", "arm64");
  return root;
}

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [script, "--desktop", root, ...args], {
    encoding: "utf8",
  });
}

describe("stage embedded postgres", () => {
  it("stages darwin-x64 when --arch x64 is passed and both packages are present", () => {
    const root = fakeDesktop();
    const result = run(root, ["--platform", "darwin", "--arch", "x64"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("@embedded-postgres/darwin-x64");
    const stagedBinary = path.join(
      root,
      "build",
      "postgres-modules",
      "@embedded-postgres",
      "darwin-x64",
      "native",
      "bin",
      "postgres",
    );
    expect(readFileSync(stagedBinary, "utf8")).toBe("fixture-binary");
    expect(
      existsSync(
        path.join(root, "build", "postgres-modules", "@embedded-postgres", "darwin-arm64"),
      ),
    ).toBe(false);
  });

  it("refuses to stage a package whose cpu does not match --arch", () => {
    const root = fakeDesktop();
    const dir = path.join(root, "node_modules", "@embedded-postgres", "darwin-x64");
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@embedded-postgres/darwin-x64", os: ["darwin"], cpu: ["arm64"] }),
    );
    const result = run(root, ["--platform", "darwin", "--arch", "x64"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Refusing to stage/);
  });
});
