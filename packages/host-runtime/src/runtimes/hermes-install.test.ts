import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { probeHermesInstall, resolveHermesLauncherAsset } from "./hermes-install.js";

it("resolves a source launcher from its module, independent of the host cwd", () => {
  const bundle = path.join(tmpdir(), "unrelated-host", "host-service.cjs");
  const hostAgentModule = new URL("../host-agent.ts", import.meta.url).href;
  expect(resolveHermesLauncherAsset(bundle, hostAgentModule)).toBe(
    path.resolve(import.meta.dirname, "../../python/hermes_launcher.py"),
  );
  expect(() => resolveHermesLauncherAsset(bundle, "file:///missing/host-agent.js")).toThrow(
    "Pinned Hermes launcher is unavailable.",
  );
});

it("prefers the packaged launcher when the module URL is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-asset-"));
  try {
    const bundle = path.join(root, "host-service.cjs");
    const launcher = path.join(root, "python", "hermes_launcher.py");
    await mkdir(path.dirname(launcher));
    await writeFile(launcher, "fixture");
    expect(resolveHermesLauncherAsset(bundle, undefined)).toBe(launcher);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("requires an explicit absolute pinned install", () => {
  expect(() => probeHermesInstall("relative-install")).toThrow("unavailable");
  if (process.platform === "win32") return;
  expect(() => probeHermesInstall(path.join(tmpdir(), "missing-install"))).toThrow("safety check");
});

it.skipIf(process.platform === "win32")("refuses a project dotenv by existence alone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-probe-"));
  try {
    await mkdir(path.join(root, ".venv", "bin"), { recursive: true });
    await writeFile(path.join(root, ".venv", "bin", "python"), "fixture");
    await writeFile(path.join(root, ".env"), "");
    expect(() => probeHermesInstall(root)).toThrow("safety check");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
