import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  HERMES_SOURCE_PIN,
  HERMES_SOURCE_TREE,
  hermesInstallCandidate,
  localHermesInstallCandidate,
  localHermesRoot,
  localHermesStaging,
  probeHermesInstall,
  qualifyHermesInstall,
  resolveHermesLauncherAsset,
} from "./hermes-install.js";

it("resolves the local root, staging and managed install under DATA_DIR", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "hermes-local-root-"));
  vi.stubEnv("DATA_DIR", data);
  vi.stubEnv("ARDUR_HERMES_INSTALL", "");
  try {
    const root = path.join(path.resolve(data), "hermes");
    expect(localHermesRoot()).toBe(root);
    expect(localHermesStaging()).toBe(path.join(root, "staging"));
    const managed = path.join(root, "runtimes", "hermes-agent");
    expect(localHermesInstallCandidate()).toBeNull();
    await mkdir(managed, { recursive: true });
    expect(localHermesInstallCandidate()).toBe(managed);
    expect(hermesInstallCandidate(localHermesStaging(), undefined)).toBe(managed);
    expect(localHermesInstallCandidate()).toBe(
      hermesInstallCandidate(localHermesStaging(), process.env.ARDUR_HERMES_INSTALL),
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(data, { recursive: true, force: true });
  }
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

it("resolves the desktop packaged launcher from the worker service bundle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-asset-"));
  try {
    const workerBundle = path.join(root, "services", "worker.mjs");
    const launcher = path.join(root, "host-service", "python", "hermes_launcher.py");
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(launcher, "fixture");
    for (const name of ["hermes_profile.py", "hermes_sources.json", "runtime_config_profile.json"])
      await writeFile(path.join(path.dirname(launcher), name), "fixture");
    expect(resolveHermesLauncherAsset(workerBundle, undefined)).toBe(launcher);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const hello = Buffer.from("hello");
const helloHash = createHash("sha256").update(hello).digest("hex");
const sources = { "hello.txt": helloHash };

function marker(pin = HERMES_SOURCE_PIN, tree = HERMES_SOURCE_TREE): string {
  return JSON.stringify({
    pin,
    tree,
    uv: "0.12.19",
    python: "3.13.2",
    installedAt: "2026-01-01T00:00:00.000Z",
  });
}

async function layoutInstall(root: string): Promise<void> {
  await mkdir(path.join(root, ".venv", "bin"), { recursive: true });
  await writeFile(path.join(root, ".venv", "bin", "python"), "fixture");
  await writeFile(path.join(root, "hello.txt"), hello);
}

async function gitStub(dir: string, revision: string): Promise<string> {
  const bin = path.join(dir, "git-bin");
  await mkdir(bin, { recursive: true });
  const argsFile = path.join(dir, "git-args");
  const git = path.join(bin, "git");
  await writeFile(
    git,
    `#!${process.execPath}\nconst fs = require("fs");\nfs.writeFileSync(process.env.HERMES_GIT_ARGS, process.argv.slice(2).join("\\n"));\nprocess.stdout.write(process.env.HERMES_GIT_REVISION + "\\n");\n`,
  );
  await chmod(git, 0o755);
  process.env.HERMES_GIT_ARGS = argsFile;
  process.env.HERMES_GIT_REVISION = revision;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  return argsFile;
}

it.skipIf(process.platform === "win32")(
  "accepts a managed install recorded by the marker and still checks file hashes",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hermes-marker-"));
    try {
      await layoutInstall(root);
      await writeFile(path.join(root, ".ardur-install.json"), marker());
      expect(qualifyHermesInstall(root, { sources }).root).toBe(realpathSync(root));
      await writeFile(path.join(root, "hello.txt"), "changed");
      expect(() => qualifyHermesInstall(root, { sources })).toThrow("provenance check");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "accepts a checkout whose own git HEAD is the pin",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hermes-git-"));
    const savedPath = process.env.PATH;
    try {
      await layoutInstall(root);
      await mkdir(path.join(root, ".git"));
      const argsFile = await gitStub(root, HERMES_SOURCE_PIN);
      const resolved = realpathSync(root);
      expect(qualifyHermesInstall(root, { sources }).root).toBe(resolved);
      expect(await readFile(argsFile, "utf8")).toBe(
        ["-C", resolved, "rev-parse", "HEAD"].join("\n"),
      );
    } finally {
      process.env.PATH = savedPath;
      delete process.env.HERMES_GIT_ARGS;
      delete process.env.HERMES_GIT_REVISION;
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "refuses a marker with the wrong pin or the wrong tree",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hermes-marker-bad-"));
    try {
      await layoutInstall(root);
      await writeFile(path.join(root, ".ardur-install.json"), marker("0".repeat(40)));
      expect(() => qualifyHermesInstall(root, { sources })).toThrow("provenance check");
      await writeFile(
        path.join(root, ".ardur-install.json"),
        marker(HERMES_SOURCE_PIN, "0".repeat(40)),
      );
      expect(() => qualifyHermesInstall(root, { sources })).toThrow("provenance check");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "refuses a git checkout whose HEAD is not the pin even when the marker matches",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hermes-git-bad-"));
    const savedPath = process.env.PATH;
    try {
      await layoutInstall(root);
      await writeFile(path.join(root, ".git"), "gitdir: /unused\n");
      await writeFile(path.join(root, ".ardur-install.json"), marker());
      await gitStub(root, "f".repeat(40));
      expect(() => qualifyHermesInstall(root, { sources })).toThrow("provenance check");
    } finally {
      process.env.PATH = savedPath;
      delete process.env.HERMES_GIT_ARGS;
      delete process.env.HERMES_GIT_REVISION;
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "refuses a python tree that has neither git metadata nor a marker",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hermes-unmarked-"));
    try {
      await layoutInstall(root);
      expect(() => probeHermesInstall(root)).toThrow("provenance check");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("resolves the source launcher from the local hermes runtime module", () => {
  const bundle = path.join(tmpdir(), "unrelated-services", "worker.mjs");
  const localModuleUrl = new URL(
    "../../../adapters/src/runtimes/local-hermes-runtime.ts",
    import.meta.url,
  ).href;
  expect(resolveHermesLauncherAsset(bundle, localModuleUrl)).toBe(
    path.resolve(import.meta.dirname, "../../python/hermes_launcher.py"),
  );
});
