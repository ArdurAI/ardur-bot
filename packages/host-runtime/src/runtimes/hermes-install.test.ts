import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  hermesInstallCandidate,
  hermesLaunchArgv,
  probeHermesInstall,
  resolveHermesLauncherAsset,
} from "./hermes-install.js";

it("wraps the pinned Hermes process in the host guardrail only on macOS", () => {
  const guard = {
    paths: ["/fixture/user-data/secrets.env"],
    ports: [55433],
    sockets: ["/fixture/run/docker.sock"],
  };
  const wrapped = hermesLaunchArgv(
    "/fixture/.venv/bin/python",
    "/fixture/launcher.py",
    guard,
    "darwin",
  );
  expect(wrapped[0]).toBe("/usr/bin/sandbox-exec");
  expect(wrapped[1]).toBe("-p");
  expect(wrapped[2]).toContain('(subpath "/fixture/user-data/secrets.env")');
  expect(wrapped[2]).toContain('(remote ip "localhost:55433")');
  expect(wrapped[2]).toContain('(remote unix-socket (literal "/fixture/run/docker.sock"))');
  expect(wrapped.slice(3)).toEqual(["/fixture/.venv/bin/python", "-B", "/fixture/launcher.py"]);
  for (const platform of ["linux", "win32"] as const)
    expect(
      hermesLaunchArgv("/fixture/.venv/bin/python", "/fixture/launcher.py", guard, platform),
    ).toEqual(["/fixture/.venv/bin/python", "-B", "/fixture/launcher.py"]);
  expect(
    hermesLaunchArgv("/fixture/.venv/bin/python", "/fixture/launcher.py", undefined, "darwin"),
  ).toEqual(["/fixture/.venv/bin/python", "-B", "/fixture/launcher.py"]);
});

it.skipIf(process.platform === "win32")(
  "prefers the explicit install over the one managed host location",
  async () => {
    const hostData = await mkdtemp(path.join(tmpdir(), "hermes-host-data-"));
    try {
      const root = path.join(hostData, "workspaces");
      const managed = path.join(hostData, "runtimes", "hermes-agent");
      await mkdir(managed, { recursive: true });
      expect(hermesInstallCandidate(root, path.join(hostData, "explicit"))).toBe(
        path.join(hostData, "explicit"),
      );
      expect(hermesInstallCandidate(root, undefined)).toBe(managed);
      await rm(managed, { recursive: true });
      expect(hermesInstallCandidate(root, undefined)).toBeNull();
    } finally {
      await rm(hostData, { recursive: true, force: true });
    }
  },
);

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
    expect(() => resolveHermesLauncherAsset(bundle, undefined)).toThrow("unavailable");
    for (const name of ["hermes_profile.py", "hermes_sources.json", "runtime_config_profile.json"])
      await writeFile(path.join(root, "python", name), "fixture");
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
