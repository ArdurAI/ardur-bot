import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { CommandRequest, ProcessEvent } from "@ardurbot/adapter-kit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ spawn: vi.fn(), environment: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));
vi.mock("./host-environment.js", async (original) => ({
  ...(await original<object>()),
  getHostEnvironment: fake.environment,
}));

import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { filterHostEnvironment } from "./host-environment.js";

const context = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "owner",
  signal: new AbortController().signal,
};
const roots: string[] = [];
beforeEach(() => {
  fake.spawn.mockReset();
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(restricted: boolean) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "host-command-")));
  roots.push(root);
  for (const name of ["bash", "echo", "gh"]) {
    await writeFile(path.join(root, name), "fixture");
    await chmod(path.join(root, name), 0o700);
  }
  fake.environment.mockResolvedValue({
    env: filterHostEnvironment({
      PATH: root,
      HOME: "/fixture/home",
      SHELL: "/bin/zsh",
      SSH_AUTH_SOCK: "/fixture/agent.sock",
      GH_TOKEN: "placeholder",
      AWS_PROFILE: "placeholder",
    }),
  });
  const provider = new DesktopSandboxProvider({ root, restricted });
  const computer = await provider.provision({ botId: "bot", homePath: "ignored" }, context);
  return {
    root,
    home: computer.providerRef,
    async execute(request: CommandRequest) {
      const events: ProcessEvent[] = [];
      for await (const event of provider.execute(computer, request, context)) events.push(event);
      return events;
    },
  };
}
function processStub(error?: string, code: number | null = 0) {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  setImmediate(() => {
    if (error)
      child.emit("error", Object.assign(new Error("private launch detail"), { code: error }));
    else {
      child.stdout!.emit("data", Buffer.from("ran"));
      child.emit("close", code, code === null ? "SIGTERM" : undefined);
    }
  });
  return child;
}
it.each([false, true])(
  "uses the same owner PATH and filtered environment in dev and bridge modes (%s)",
  async (restricted) => {
    const { execute, root } = await fixture(restricted);
    fake.spawn.mockImplementation(() => processStub());
    expect(
      await execute({ argv: ["bash", "-c", "which gh && gh auth status 2>&1 | head -5"] }),
    ).toContainEqual({ type: "exit", code: 0 });
    const [binary, args, options] = fake.spawn.mock.calls[0]!;
    expect(binary).toBe(path.join(root, "bash"));
    expect(args).toEqual(["-c", "which gh && gh auth status 2>&1 | head -5"]);
    expect(options.shell).toBe(false);
    expect(options.env).toEqual({
      PATH: root,
      HOME: "/fixture/home",
      SHELL: "/bin/zsh",
      SSH_AUTH_SOCK: "/fixture/agent.sock",
    });
  },
);
it.each(["ENOENT", "EACCES"])(
  "reports that even echo did not run after a spawn failure (%s)",
  async (code) => {
    const { execute } = await fixture(true);
    fake.spawn.mockImplementation(() => processStub(code));
    expect(await execute({ argv: ["echo", "must not fabricate this output"] })).toEqual([
      {
        type: "stderr",
        data: `Command did not run: the host could not start the executable (${code}).`,
      },
      { type: "exit", code: 127 },
    ]);
  },
);
it("returns an honest failure for a synchronous launch error and signal exit", async () => {
  const { execute } = await fixture(false);
  fake.spawn.mockImplementation(() => {
    throw new Error("private launch detail");
  });
  expect(await execute({ argv: ["gh", "auth", "status"] })).toEqual([
    {
      type: "stderr",
      data: "Command did not run: the host could not start the executable (launch failed).",
    },
    { type: "exit", code: 127 },
  ]);
  fake.spawn.mockImplementation(() => processStub(undefined, null));
  const events = await execute({ argv: ["gh"] });
  expect(events).toContainEqual({ type: "exit", code: 1 });
  expect(events).toContainEqual({
    type: "stderr",
    data: "Command stopped before completion (SIGTERM).",
  });
});
it("returns a command-did-not-run result for a missing binary and refuses environment overrides before spawn", async () => {
  const { execute } = await fixture(true);
  expect(await execute({ argv: ["missing"] })).toEqual([
    {
      type: "stderr",
      data: "Command did not run: executable was not found on this computer's PATH.",
    },
    { type: "exit", code: 127 },
  ]);
  const events = await execute({ argv: ["gh"], env: { PATH: "/caller/bin" } });
  expect(events.at(-1)).toEqual({ type: "exit", code: 127 });
  expect(fake.spawn).not.toHaveBeenCalled();
});
it("confines source-mode cwd creation and refuses an escaping symlink before spawn", async () => {
  const { execute, root, home } = await fixture(false);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(home, "escape"), "junction");
  await expect(execute({ argv: ["gh"], cwd: "escape/nested" })).rejects.toThrow("escapes");
  expect(await readdir(outside)).toEqual([]);
  expect(fake.spawn).not.toHaveBeenCalled();
  fake.spawn.mockImplementation(() => processStub());
  expect(await execute({ argv: ["gh"], cwd: "nested/folder" })).toContainEqual({
    type: "exit",
    code: 0,
  });
  expect(fake.spawn.mock.calls[0]![2].cwd).toBe(path.join(home, "nested/folder"));
});
