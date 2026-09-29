import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  guardNativeSpawn,
  type NativeSpawn,
  nativeBinaryCandidates,
  nativeEnvironment,
} from "./runtimes/native-process.js";

describe("native platform launch policy", () => {
  it("uses Windows executable paths and ignores relative search entries and shell wrappers", () => {
    expect(
      nativeBinaryCandidates(
        "codex",
        { PATH: "relative;C:\\Apps;D:\\Tools", USERPROFILE: "C:\\Fixture" },
        "win32",
      ),
    ).toEqual(["C:\\Apps\\codex.exe", "D:\\Tools\\codex.exe"]);
  });
  it("keeps Linux discovery absolute and does not inherit injection or credential variables", () => {
    expect(
      nativeBinaryCandidates("claude", { PATH: ":relative:/usr/bin", HOME: "/fixture" }, "linux"),
    ).toEqual(["/usr/bin/claude"]);
    expect(
      nativeEnvironment({
        HOME: "/fixture",
        PATH: "/usr/bin",
        NODE_OPTIONS: "injection",
        LD_PRELOAD: "injection",
        DYLD_INSERT_LIBRARIES: "injection",
        CLAUDE_CODE_OAUTH_TOKEN: "secret",
        OPENAI_API_KEY: "secret",
      }),
    ).toEqual({ HOME: "/fixture", PATH: "/usr/bin" });
  });
  it("keeps the fixed MCP relay in Electron Node mode and authenticates its named pipe", () => {
    const source = readFileSync(new URL("./runtimes/ardur-mcp-server.ts", import.meta.url), "utf8");
    expect(source).toContain('env: { ELECTRON_RUN_AS_NODE: "1" }');
    expect(source).toContain("timingSafeEqual");
    expect(source).toContain(`ardur-tools-\${randomUUID()}`);
  });
});

describe("guardNativeSpawn", () => {
  const base = vi.fn() as unknown as NativeSpawn;
  const guard = {
    paths: ["/fixture/user-data/secrets.env"],
    ports: [55433],
    sockets: ["/fixture/run/docker.sock"],
  };
  it("wraps the launch with sandbox-exec on macOS", () => {
    const start = guardNativeSpawn(base, guard, "darwin");
    start("/fixture/bin/claude", ["-p"], "/fixture/work");
    const [binary, args, cwd] = (base as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(binary).toBe("/usr/bin/sandbox-exec");
    expect(args[0]).toBe("-p");
    expect(args[1]).toContain('(subpath "/fixture/user-data/secrets.env")');
    expect(args[1]).toContain('(remote ip "localhost:55433")');
    expect(args[1]).toContain('(remote unix-socket (literal "/fixture/run/docker.sock"))');
    expect(args.slice(2)).toEqual(["/fixture/bin/claude", "-p"]);
    expect(cwd).toBe("/fixture/work");
  });
  it("passes through off macOS and without a guard", () => {
    for (const start of [
      guardNativeSpawn(base, guard, "linux"),
      guardNativeSpawn(base, guard, "win32"),
      guardNativeSpawn(base, undefined, "darwin"),
      guardNativeSpawn(base, { paths: [], ports: [], sockets: [] }, "darwin"),
    ]) {
      start("/fixture/bin/claude", ["-p"], "/fixture/work");
      const [binary, args] = (base as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      expect(binary).toBe("/fixture/bin/claude");
      expect(args).toEqual(["-p"]);
    }
  });
});
