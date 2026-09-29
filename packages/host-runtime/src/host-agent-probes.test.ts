import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  spawn: vi.fn(),
  env: {
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    SHELL: "/bin/zsh",
  } as NodeJS.ProcessEnv,
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: fake.spawn };
});

// Profile building realpaths engine sockets. A missing socket must stay missing:
// resolving the real engine socket on this machine is out of scope for the test.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const realpathSync = ((target: string) => {
    if (/docker\.sock|podman\.sock|\.s\.PGSQL|com\.docker\.docker/.test(String(target))) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return actual.realpathSync(target);
  }) as typeof actual.realpathSync;
  return { ...actual, realpathSync };
});

vi.mock("./host-environment.js", async () => {
  const actual =
    await vi.importActual<typeof import("./host-environment.js")>("./host-environment.js");
  return {
    ...actual,
    getHostEnvironment: async () => ({ env: fake.env }),
    inspectHostEnvironment: async () => ({ tools: [] }),
  };
});

vi.mock("./host-integrations.js", () => ({
  inspectHostIntegrations: async () => [],
}));

import { HostAgent } from "./host-agent.js";
import { setHostCommandGuard } from "./host-environment.js";
import { probeAntigravity } from "./runtimes/antigravity-runtime.js";
import { probeClaude } from "./runtimes/claude-code-runtime.js";
import { probeCodex } from "./runtimes/codex-app-server-runtime.js";
import { guardNativeSpawn, spawnNative } from "./runtimes/native-process.js";

const roots: string[] = [];

function child(code: number | null = 1) {
  const proc = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(proc, { stdin, stdout, stderr, kill: vi.fn(() => true), pid: 4242 });
  stdin.on("finish", () => {
    queueMicrotask(() => proc.emit("close", code));
  });
  return proc;
}

function launched(binary: string, args: readonly string[]) {
  if (path.basename(binary) === "sandbox-exec")
    return { binary: args[2] ?? "", args: args.slice(3), profile: args[1] };
  return { binary, args, profile: undefined as string | undefined };
}

function versionProbes() {
  return fake.spawn.mock.calls.filter(([binary, args]) => {
    const command = launched(String(binary), args as string[]);
    return command.args[0] === "--version";
  });
}

async function withoutVitest<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.VITEST;
  delete process.env.VITEST;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.VITEST;
    else process.env.VITEST = previous;
  }
}

function stubControlPlane() {
  vi.stubEnv("HOME", "/fixture/home");
  vi.stubEnv("DOCKER_HOST", "");
  vi.stubEnv("CONTAINER_HOST", "");
  vi.stubEnv("LIMA_HOME", "/fixture/lima");
  vi.stubEnv("XDG_RUNTIME_DIR", "/fixture/run");
  vi.stubEnv("XDG_DATA_HOME", "/fixture/data");
  vi.stubEnv("DATA_DIR", "/fixture/data-dir");
  vi.stubEnv("DATABASE_URL", "postgres://app@127.0.0.1:23456/ardurbot");
  vi.stubEnv("REALTIME_DATABASE_URL", "postgres://app@10.1.2.3:5432/remote");
  vi.stubEnv("SANDBOX_SUPERVISOR_URL", "http://127.0.0.1:17091");
  vi.stubEnv("API_URL", "");
  vi.stubEnv("API_PORT", "");
  vi.stubEnv("PGHOST", "");
  vi.stubEnv("ARDURBOT_PG_SOCKET_DIR", "");
  vi.stubEnv("ARDURBOT_GUARD_PATHS", "");
  vi.stubEnv("ARDURBOT_ENV_FILE", "");
  vi.stubEnv("ARDUR_HERMES_INSTALL", "");
}

beforeEach(() => {
  fake.spawn.mockReset();
  fake.spawn.mockImplementation(() => child(1));
  stubControlPlane();
});

afterEach(async () => {
  setHostCommandGuard(undefined);
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function installFakeClis() {
  const root = await mkdtemp(path.join(tmpdir(), "host-probes-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of ["claude", "codex", "agy"]) {
    const file = path.join(bin, name);
    await writeFile(file, "#!/bin/sh\nexit 1\n");
    await chmod(file, 0o755);
  }
  fake.env = { PATH: bin, HOME: "/fixture/home", SHELL: "/bin/zsh" };
  return root;
}

describe("host version probes", () => {
  it("denies the paired database and supervisor ports from the host agent", async () => {
    const root = await installFakeClis();
    const agent = new HostAgent(
      {
        root,
        hostRoots: [root],
        guardPorts: [23456, 17091],
        apiUrl: "http://127.0.0.1:3100",
      },
      { send: async () => undefined, close() {} },
    );
    // The default resolver skips Antigravity while Vitest is set. Production health does not.
    await withoutVitest(() => agent.health());
    const probes = versionProbes();
    expect(probes.length).toBeGreaterThanOrEqual(3);
    const names = probes.map(([binary, args]) =>
      path.basename(launched(String(binary), args as string[]).binary),
    );
    expect(names).toEqual(expect.arrayContaining(["claude", "codex", "agy"]));
    if (process.platform === "darwin") {
      expect(fake.spawn.mock.calls.every(([binary]) => binary === "/usr/bin/sandbox-exec")).toBe(
        true,
      );
      const profiles = fake.spawn.mock.calls.map(([, args]) => String((args as string[])[1]));
      expect(
        profiles.some(
          (profile) =>
            profile.includes("localhost:23456") &&
            profile.includes("localhost:17091") &&
            profile.includes("localhost:3100"),
        ),
      ).toBe(true);
    } else {
      expect(
        probes.every(([binary]) =>
          ["claude", "codex", "agy"].includes(path.basename(String(binary))),
        ),
      ).toBe(true);
    }
  });

  it("wraps an omitted or explicit undefined probe spawn", async () => {
    await installFakeClis();
    await withoutVitest(async () => {
      await probeClaude(undefined);
      await probeCodex(undefined);
      await probeAntigravity(undefined, undefined, false);
    });
    const probes = versionProbes();
    expect(probes.length).toBeGreaterThanOrEqual(3);
    const names = probes.map(([binary, args]) =>
      path.basename(launched(String(binary), args as string[]).binary),
    );
    expect(names).toEqual(expect.arrayContaining(["claude", "codex", "agy"]));
    if (process.platform === "darwin") {
      expect(fake.spawn.mock.calls.every(([binary]) => binary === "/usr/bin/sandbox-exec")).toBe(
        true,
      );
      expect(String(fake.spawn.mock.calls[0]?.[1]?.[1])).toContain("localhost:23456");
      expect(String(fake.spawn.mock.calls[0]?.[1]?.[1])).toContain("localhost:17091");
    } else {
      expect(
        probes.every(([binary]) =>
          ["claude", "codex", "agy"].includes(path.basename(String(binary))),
        ),
      ).toBe(true);
    }
  });

  it("fails closed when the probe profile cannot be built", async () => {
    await installFakeClis();
    const start = guardNativeSpawn(
      spawnNative,
      { paths: ["/bad\npath"], ports: [], sockets: [] },
      "darwin",
    );
    const [claude, codex, antigravity] = await Promise.all([
      probeClaude(start),
      probeCodex(start),
      probeAntigravity(start, async () => "/bin/echo"),
    ]);
    expect(claude.available).toBe(false);
    expect(codex.available).toBe(false);
    expect(antigravity.available).toBe(false);
    expect(fake.spawn).not.toHaveBeenCalled();
  });
});
