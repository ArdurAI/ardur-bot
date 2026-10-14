import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import signedConfig from "./signed-mac-config.mjs";
import verify from "./verify-mac-pty-signatures.mjs";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "pty-signatures-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const context = () => ({
  electronPlatformName: "darwin",
  appOutDir: directory,
  packager: { appInfo: { productFilename: "Ardur" } },
});
it("keeps hardened runtime, notarization and mandatory signing for the native resources", () => {
  expect(signedConfig.mac).toMatchObject({
    hardenedRuntime: true,
    notarize: true,
    strictVerify: true,
  });
  expect(signedConfig.forceCodeSigning).toBe(true);
  expect(signedConfig.afterSign).toBe("./scripts/verify-mac-pty-signatures.mjs");
});
async function fixture(arch: string) {
  const root = path.join(
    directory,
    "Ardur.app",
    "Contents",
    "Resources",
    "host-service",
    "native",
    `mac_${arch}`,
    "node-pty",
    "prebuilds",
    `darwin-${arch}`,
  );
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "pty.node"), "fixture-addon");
  await writeFile(path.join(root, "spawn-helper"), "fixture-helper", { mode: 0o755 });
  return root;
}
it.each(["arm64", "x64"])("verifies both native signatures outside asar for %s", async (arch) => {
  const root = await fixture(arch);
  const run = vi.fn();
  verify(context(), run);
  expect(run.mock.calls).toEqual([
    ["codesign", ["--verify", "--strict", path.join(root, "pty.node")], { stdio: "inherit" }],
    ["codesign", ["--verify", "--strict", path.join(root, "spawn-helper")], { stdio: "inherit" }],
    [
      "codesign",
      ["--verify", "--deep", "--strict", path.join(directory, "Ardur.app")],
      { stdio: "inherit" },
    ],
  ]);
});
it("fails the signed build if a helper lost execute permission", async () => {
  const root = await fixture("arm64");
  await chmod(path.join(root, "spawn-helper"), 0o644);
  expect(() => verify(context(), vi.fn())).toThrow("not executable");
});
it("fails the signed build on a signature error", async () => {
  await fixture("arm64");
  expect(() =>
    verify(context(), () => {
      throw new Error("invalid signature");
    }),
  ).toThrow("invalid signature");
});
it("rejects packaging both architectures together", async () => {
  await fixture("arm64");
  await fixture("x64");
  expect(() => verify(context(), vi.fn())).toThrow("exactly one");
});
it("does nothing on other platforms", () => {
  const run = vi.fn();
  verify({ ...context(), electronPlatformName: "win32" }, run);
  expect(run).not.toHaveBeenCalled();
});
