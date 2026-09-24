import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitOperationError,
  GitTransport,
  validateGitBranch,
  validateGitRemote,
} from "./git-transport.js";

const exec = promisify(execFile);
afterEach(() => vi.unstubAllEnvs());
describe("Git transport boundary", () => {
  it("requires credential-free HTTPS or SSH URLs on deployment-allowed hosts", () => {
    expect(validateGitRemote("https://github.com/fixture/memory.git").host).toBe("github.com");
    expect(validateGitRemote("ssh://git@github.com/fixture/memory.git").protocol).toBe("ssh");
    for (const url of [
      "file:///fixture/repo",
      "http://github.com/fixture/repo",
      "https://example.test/fixture/repo",
      "https://user:password@github.com/fixture/repo",
      "https://user@github.com/fixture/repo",
      "ssh://other@github.com/fixture/repo",
      "https://github.com:444/fixture/repo",
      "https://github.com/fixture/repo?next=bad",
      "https://github.com/fixture/%2e%2e",
      "ext::command",
    ])
      expect(() => validateGitRemote(url)).toThrow();
    expect(
      validateGitRemote("https://git.example.test/fixture/repo", ["git.example.test"]).host,
    ).toBe("git.example.test");
    for (const branch of [
      "--upload-pack=bad",
      "main..bad",
      "main.lock",
      "main/@{bad",
      "main//bad",
      "main\nother",
    ])
      expect(() => validateGitBranch(branch)).toThrow();
  });
  it("passes token authentication only through a private askpass socket and sanitizes failures", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "git-transport-fixture-")));
    const value = randomBytes(32).toString("hex");
    const observe = vi.fn();
    const transport = new GitTransport({
      root,
      remote: validateGitRemote("https://github.com/fixture/memory.git"),
      credential: async () => ({ kind: "token", value }),
      observe,
    });
    vi.stubEnv("UNRELATED_CREDENTIAL", value);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "credential.helper");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "untrusted");
    let helper = "";
    try {
      await transport.initialize();
      for (const [argv, env] of observe.mock.calls) {
        expect(JSON.stringify({ argv, env }).includes(value)).toBe(false);
        expect(env.UNRELATED_CREDENTIAL).toBeUndefined();
        expect(env.GIT_CONFIG_COUNT).toBeUndefined();
        expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
        expect(argv).toContain("core.fsmonitor=false");
      }
      vi.spyOn(transport, "run").mockImplementation(async (_argv, options) => {
        helper = options?.env?.GIT_ASKPASS ?? "";
        expect(JSON.stringify({ _argv, options }).includes(value)).toBe(false);
        expect((await exec(helper, ["Username for repository"])).stdout).toBe("x-access-token");
        const password = await exec(helper, ["Password for repository"]);
        expect(password.stdout === value).toBe(true);
        throw new Error(value);
      });
      await expect(transport.fetch("main", AbortSignal.timeout(5000))).rejects.toThrow(
        new GitOperationError().message,
      );
      await expect(readFile(helper)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify(observe.mock.calls).includes(value)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps deploy keys out of arguments and environment and removes the temporary identity", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "git-ssh-fixture-")));
    const value = randomBytes(32).toString("base64");
    const transport = new GitTransport({
      root,
      remote: validateGitRemote("ssh://git@github.com/fixture/memory.git"),
      credential: async () => ({ kind: "ssh", value }),
    });
    let key = "";
    try {
      await transport.initialize();
      vi.spyOn(transport, "run").mockImplementation(async (argv, options) => {
        const helper = options?.env?.GIT_SSH ?? "";
        const script = await readFile(helper, "utf8");
        expect(JSON.stringify({ argv, env: options?.env, script }).includes(value)).toBe(false);
        expect(script).toContain("StrictHostKeyChecking=yes");
        key = path.join(path.dirname(helper), "identity");
        expect((await readFile(key, "utf8")).trim() === value).toBe(true);
        return "";
      });
      expect(await transport.fetch("main", AbortSignal.timeout(5000))).toBeNull();
      await expect(readFile(key)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
