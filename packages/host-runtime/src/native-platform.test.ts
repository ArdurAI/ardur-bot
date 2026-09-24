import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nativeBinaryCandidates, nativeEnvironment } from "./runtimes/native-process.js";

describe("native platform launch policy", () => {
  it("uses Windows executable paths and ignores relative search entries and shell wrappers", () => {
    expect(
      nativeBinaryCandidates(
        "codex",
        { PATH: "relative;C:\\Apps;D:\\Tools", USERPROFILE: "C:\\Fixture" },
        "win32",
      ),
    ).toEqual([
      "C:\\Apps\\codex.exe",
      "D:\\Tools\\codex.exe",
      "C:\\Fixture\\.local\\bin\\codex.exe",
    ]);
  });
  it("keeps Linux discovery absolute and does not inherit injection or credential variables", () => {
    expect(
      nativeBinaryCandidates("claude", { PATH: ":relative:/usr/bin", HOME: "/fixture" }, "linux"),
    ).toEqual(["/usr/bin/claude", "/fixture/.local/bin/claude"]);
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
    expect(source).toContain("ardur-tools-${randomUUID()}");
  });
});
