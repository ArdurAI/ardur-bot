import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { HOST_TOOLS, hostEnvironmentNote } from "@ardurbot/contracts/host-bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));

import {
  captureHostEnvironment,
  filterHostEnvironment,
  inspectHostEnvironment,
  redactHostStatus,
  resolveHostBinary,
} from "./host-environment.js";

const roots: string[] = [];
function child(output = "", code: number | null = 0, error?: string) {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  Object.assign(process, {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  process.stdin.on("finish", () =>
    queueMicrotask(() => {
      if (error)
        process.emit("error", Object.assign(new Error("private launch detail"), { code: error }));
      else {
        stdout.end(output);
        process.emit("close", code);
      }
    }),
  );
  return process;
}
beforeEach(() => {
  fake.spawn.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("host login environment", () => {
  it("captures a framed login PATH and passes SHELL, OS config and the real home only", async () => {
    fake.spawn.mockReturnValue(child("profile banner\n\0/fixture/bin:/usr/bin\0"));
    const source = {
      PATH: "/usr/bin",
      HOME: "/virtual-home",
      SHELL: "/bin/zsh",
      SSH_AUTH_SOCK: "/fixture/agent.sock",
      XDG_CONFIG_HOME: "/fixture/config",
      XDG_DATA_HOME: "/fixture/data",
      XDG_CACHE_HOME: "/fixture/cache",
      HOMEBREW_PREFIX: "/fixture/brew",
      GH_TOKEN: "placeholder",
      OPENAI_API_KEY: "placeholder",
    };
    const result = await captureHostEnvironment(source, "darwin", "/fixture/home");
    expect(result.diagnostic).toBeUndefined();
    expect(result.env).toMatchObject({
      PATH: "/fixture/bin:/usr/bin",
      HOME: "/fixture/home",
      SHELL: "/bin/zsh",
      SSH_AUTH_SOCK: source.SSH_AUTH_SOCK,
      XDG_CONFIG_HOME: source.XDG_CONFIG_HOME,
      XDG_DATA_HOME: source.XDG_DATA_HOME,
      XDG_CACHE_HOME: source.XDG_CACHE_HOME,
      HOMEBREW_PREFIX: source.HOMEBREW_PREFIX,
    });
    expect(result.env).not.toHaveProperty("GH_TOKEN");
    expect(fake.spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-lc", 'printf "\\0%s\\0" "$PATH"'],
      expect.objectContaining({
        env: expect.objectContaining({ HOME: "/fixture/home", SHELL: "/bin/zsh" }),
        shell: false,
      }),
    );
    expect(fake.spawn.mock.calls[0]![2].env).not.toHaveProperty("OPENAI_API_KEY");
  });
  it("preserves a login PATH split across multibyte output chunks", async () => {
    const process = child();
    process.stdin.removeAllListeners("finish");
    const output = Buffer.from("\0/fixture/工具/bin:/usr/bin\0");
    process.stdin.on("finish", () => {
      for (const byte of output) process.stdout.emit("data", Buffer.from([byte]));
      process.emit("close", 0);
    });
    fake.spawn.mockReturnValue(process);
    const result = await captureHostEnvironment({ SHELL: "/bin/zsh" }, "darwin", "/fixture/home");
    expect(result.env.PATH).toBe("/fixture/工具/bin:/usr/bin");
    expect(result.diagnostic).toBeUndefined();
  });
  it.each([
    [1, "\0/ignored/bin\0", undefined, "exit 1"],
    [0, "", undefined, "exit 0"],
    [0, "\0\0", undefined, "exit 0"],
    [null, "", "ENOENT", "exit not started"],
    [null, "", undefined, "exit signal"],
  ])(
    "keeps a usable default PATH when capture fails (%s, %s)",
    async (code, output, error, exit) => {
      fake.spawn.mockReturnValue(child(output, code, error));
      const result = await captureHostEnvironment(
        { SHELL: "/bin/zsh", PATH: "/existing/bin" },
        "darwin",
        "/fixture/home",
      );
      expect(result.env.PATH?.split(":")).toEqual([
        "/existing/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ]);
      expect(result.diagnostic).toBe(
        `Your login shell profile failed to load (zsh, ${exit}); commands run with a default PATH`,
      );
      expect(result.diagnostic).not.toContain("private");
    },
  );
  it("settles and kills a timed-out profile even if it never sends close", async () => {
    vi.useFakeTimers();
    const hung = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(hung, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    fake.spawn.mockReturnValue(hung);
    const capture = captureHostEnvironment({ SHELL: "/bin/bash" }, "linux", "/fixture/home");
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await capture;
    expect(result.diagnostic).toContain("bash, exit timeout");
    expect(result.env.PATH).toContain("/usr/local/bin:/usr/bin:/bin");
    expect(hung.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("bounds noisy profiles and never exposes their output", async () => {
    fake.spawn.mockReturnValue(child("x".repeat(20_000)));
    const result = await captureHostEnvironment({ SHELL: "/bin/zsh" }, "darwin", "/fixture/home");
    expect(result.diagnostic).toContain("exit output limit");
    expect(JSON.stringify(result)).not.toContain("x".repeat(100));
  });
  it("excludes secret patterns and injection variables regardless of casing", () => {
    const denied = [
      "TOKEN",
      "MY_SECRET",
      "API_KEY",
      "PASSWORD",
      "CREDENTIAL",
      "AWS_PROFILE",
      "AWS_ACCESS_KEY_ID",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "custom_token",
      "NODE_OPTIONS",
      "BASH_ENV",
      "ENV",
      "ZDOTDIR",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
    ];
    const env = filterHostEnvironment({
      ...Object.fromEntries(denied.map((name) => [name, "placeholder"])),
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      SHELL: "/bin/zsh",
    });
    expect(env).toEqual({ PATH: "/fixture/bin", HOME: "/fixture/home", SHELL: "/bin/zsh" });
    for (const name of denied) expect(env).not.toHaveProperty(name);
  });
  it("reads Windows registry PATH with no login shell and handles case-insensitive variables", async () => {
    fake.spawn.mockImplementation((_binary, args) =>
      child(
        args[1].startsWith("HKLM")
          ? "    Path    REG_EXPAND_SZ    %SystemRoot%\\System32\r\n"
          : "    Path    REG_SZ    C:\\Tools;C:\\OwnerTools\r\n",
      ),
    );
    const result = await captureHostEnvironment(
      {
        Path: "C:\\Stale",
        SYSTEMROOT: "C:\\Windows",
        USERPROFILE: "C:\\Fixture",
        SHELL: "/bin/bash",
        gh_token: "placeholder",
      },
      "win32",
      "C:\\Fixture",
    );
    expect(result.env.PATH).toBe("C:\\Windows\\System32;C:\\Tools;C:\\OwnerTools");
    expect(result.env.HOME).toBe("C:\\Fixture");
    expect(result.diagnostic).toBeUndefined();
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    for (const [binary, args, options] of fake.spawn.mock.calls) {
      expect(binary).toBe("C:\\Windows\\System32\\reg.exe");
      expect(args[0]).toBe("query");
      expect(options.shell).toBe(false);
      expect(options.env).not.toHaveProperty("gh_token");
    }
  });
  it("keeps inherited Windows PATH if registry reads fail, without trying a shell", async () => {
    fake.spawn.mockImplementation(() => child("", 1));
    const result = await captureHostEnvironment(
      { Path: "C:\\Tools", SystemRoot: "C:\\Windows" },
      "win32",
      "C:\\Fixture",
    );
    expect(result.env.PATH).toBe("C:\\Tools");
    expect(fake.spawn.mock.calls.every(([binary]) => binary.endsWith("reg.exe"))).toBe(true);
  });
  it("captures once for concurrent host users and reuses it for native launches", async () => {
    vi.resetModules();
    fake.spawn.mockImplementation((_binary, args) =>
      args[0] === "-lc" ? child("\0/fixture/bin\0") : child(),
    );
    vi.stubEnv("SHELL", "/bin/zsh");
    const environment = await import("./host-environment.js");
    const [first, second] = await Promise.all([
      environment.getHostEnvironment(),
      environment.getHostEnvironment(),
    ]);
    expect(first).toBe(second);
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    const { spawnNative } = await import("./runtimes/native-process.js");
    spawnNative("/fixture/bin/claude", ["--version"]);
    spawnNative("/fixture/bin/codex", ["app-server"]);
    for (const [, , options] of fake.spawn.mock.calls.slice(1)) {
      expect(options.env.PATH).toBe("/fixture/bin");
      expect(options.env.SHELL).toBe("/bin/zsh");
      expect(options.env.HOME).toBe(first.env.HOME);
      expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
    }
  });
});

describe("host inventory", () => {
  async function binaries(names: readonly string[]) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "host-inventory-")));
    roots.push(root);
    for (const name of names) {
      const file = path.join(root, name);
      await writeFile(file, "fixture");
      await chmod(file, 0o700);
    }
    return root;
  }
  it("detects tools on the captured PATH, probes only permitted statuses, and redacts emails", async () => {
    const root = await binaries(HOST_TOOLS);
    fake.spawn.mockImplementation((binary, args) =>
      child(
        path.basename(binary) === "kubectl"
          ? "fixture-user@example.test/context\nignored second line"
          : args[0] === "--version"
            ? "gh version 2.80.0\n"
            : "private authentication output",
      ),
    );
    const environment = await inspectHostEnvironment(
      Promise.resolve({ env: { PATH: root, HOME: "/fixture/home" } }),
    );
    expect(environment.tools.map((tool) => tool.name)).toEqual(HOST_TOOLS);
    expect(environment.tools.find((tool) => tool.name === "gh")).toEqual({
      name: "gh",
      version: "2.80.0",
      status: "signed in",
    });
    expect(environment.tools.find((tool) => tool.name === "kubectl")).toEqual({
      name: "kubectl",
      context: "[email]/context",
      status: "not checked",
    });
    expect(environment.tools.find((tool) => tool.name === "aws")?.status).toBe("not checked");
    expect(fake.spawn.mock.calls.map(([binary, args]) => [path.basename(binary), args])).toEqual([
      ["gh", ["--version"]],
      ["gh", ["auth", "status"]],
      ["kubectl", ["config", "current-context"]],
    ]);
    const note = hostEnvironmentNote(environment);
    expect(note).toContain("gh 2.80.0 (signed in)");
    expect(note).toContain("Ask-first");
    expect(note).not.toMatch(/example.test|private authentication|ignored|\n/);
  });
  it("does not infer a missing binary or signed-out account from a failed status probe", async () => {
    const root = await binaries(["gh"]);
    fake.spawn.mockImplementation(() => child("", 1));
    const captured = Promise.resolve({ env: { PATH: root } });
    expect((await inspectHostEnvironment(captured)).tools[0]).toEqual({
      name: "gh",
      version: undefined,
      status: "not checked",
    });
    fake.spawn.mockImplementation(() => child("", null, "ENOENT"));
    expect((await inspectHostEnvironment(captured)).tools[0]?.status).toBe("not checked");
  });
  it("lists tools for Settings without running status commands on health refresh", async () => {
    const root = await binaries(["gh", "kubectl", "aws"]);
    expect(await inspectHostEnvironment(Promise.resolve({ env: { PATH: root } }), false)).toEqual({
      tools: [
        { name: "gh", status: "not checked" },
        { name: "kubectl", status: "not checked" },
        { name: "aws", status: "not checked" },
      ],
    });
    expect(fake.spawn).not.toHaveBeenCalled();
  });
  it("ignores non-executable files, directories and caller paths", async () => {
    const root = await binaries(["git"]);
    await writeFile(path.join(root, "gh"), "fixture", { mode: 0o600 });
    await mkdir(path.join(root, "kubectl"));
    expect(await resolveHostBinary("git", { PATH: `relative:${root}` })).toBe(
      path.join(root, "git"),
    );
    for (const name of ["gh", "kubectl", path.join(root, "git"), "../git"])
      expect(await resolveHostBinary(name, { PATH: root })).toBeUndefined();
  });
  it("keeps a diagnostic in the single-paragraph note, including an empty inventory", () => {
    const diagnostic =
      "Your login shell profile failed to load (zsh, exit 1); commands run with a default PATH";
    const note = hostEnvironmentNote({ tools: [], diagnostic });
    expect(note).toContain("none detected");
    expect(note).toContain(diagnostic);
    expect(note).not.toContain("\n");
    expect(redactHostStatus("token=placeholder person@example.test\nprivate")).toBe(
      "[redacted] [email]",
    );
  });
});
