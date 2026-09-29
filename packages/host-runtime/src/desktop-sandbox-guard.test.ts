import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

function processStub(code = 0) {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  setImmediate(() => {
    child.stdout!.emit("data", Buffer.from("ran"));
    child.emit("close", code, code === null ? "SIGTERM" : undefined);
  });
  return child;
}

async function fixture(opts: {
  guard?: { paths: string[]; ports: number[]; sockets: string[] };
  platform?: NodeJS.Platform;
}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "host-guard-")));
  roots.push(root);
  for (const name of ["bash", "echo"]) {
    await writeFile(path.join(root, name), "fixture");
    await chmod(path.join(root, name), 0o700);
  }
  // A fake control-plane file beside the computer workspaces; no real secrets are used.
  await mkdir(path.join(root, "control-plane"));
  await writeFile(path.join(root, "control-plane", "secrets.env"), "FAKE=1\n");
  fake.environment.mockResolvedValue({
    env: filterHostEnvironment({ PATH: root, HOME: "/fixture/home", SHELL: "/bin/zsh" }),
  });
  const provider = new DesktopSandboxProvider({
    root,
    restricted: true,
    hostRoots: [root],
    guard: opts.guard ?? {
      paths: [path.join(root, "control-plane")],
      ports: [55433],
      sockets: [path.join(root, "control-plane", "engine.sock")],
    },
    ...(opts.platform ? { platform: opts.platform } : {}),
  });
  const computer = await provider.provision({ botId: "bot", homePath: "ignored" }, context);
  return {
    root,
    provider,
    computer,
    async execute(request: CommandRequest) {
      const events: ProcessEvent[] = [];
      for await (const event of provider.execute(computer, request, context)) events.push(event);
      return events;
    },
  };
}

it("wraps host commands in sandbox-exec on macOS with the computed deny profile", async () => {
  const { root, execute } = await fixture({ platform: "darwin" });
  fake.spawn.mockImplementation(() => processStub());
  expect(await execute({ argv: ["echo", "hi"] })).toContainEqual({ type: "exit", code: 0 });
  const [binary, args] = fake.spawn.mock.calls[0]!;
  expect(binary).toBe("/usr/bin/sandbox-exec");
  expect(args[0]).toBe("-p");
  const profile = args[1];
  expect(profile).toContain("(allow default)");
  expect(profile).toContain(`(subpath "${path.join(root, "control-plane")}")`);
  expect(profile).toContain('(remote ip "localhost:55433")');
  expect(profile).toContain(
    `(remote unix-socket (literal "${path.join(root, "control-plane", "engine.sock")}"))`,
  );
  // The real command follows the profile untouched.
  expect(args.slice(2)).toEqual([path.join(root, "echo"), "hi"]);
});

it("runs commands unwrapped off macOS without implying protection", async () => {
  const { root, execute } = await fixture({ platform: "linux" });
  fake.spawn.mockImplementation(() => processStub());
  expect(await execute({ argv: ["echo", "hi"] })).toContainEqual({ type: "exit", code: 0 });
  const [binary, args] = fake.spawn.mock.calls[0]!;
  expect(binary).toBe(path.join(root, "echo"));
  expect(args).toEqual(["hi"]);
});

it("runs unwrapped when no guardrail is configured", async () => {
  const { root, execute } = await fixture({
    guard: { paths: [], ports: [], sockets: [] },
    platform: "darwin",
  });
  fake.spawn.mockImplementation(() => processStub());
  await execute({ argv: ["echo", "hi"] });
  expect(fake.spawn.mock.calls[0]![0]).toBe(path.join(root, "echo"));
});

it("fails the command closed when the guardrail profile cannot be built", async () => {
  const { execute } = await fixture({
    guard: { paths: [], ports: [70000], sockets: [] },
    platform: "darwin",
  });
  const events = await execute({ argv: ["echo", "hi"] });
  expect(events).toContainEqual({
    type: "stderr",
    data: "Invalid host guardrail port.",
  });
  expect(events).toContainEqual({ type: "exit", code: 127 });
  expect(fake.spawn).not.toHaveBeenCalled();
});

it("refuses file reads and writes on protected paths with a clear error", async () => {
  const { root, provider, computer } = await fixture({ platform: "darwin" });
  // A registered folder is served through a computer rooted at that folder (bridge mapping).
  const folderComputer = { ...computer, id: "folder", botId: "folder", providerRef: root };
  await expect(
    provider.readFile(folderComputer, "control-plane/secrets.env", context),
  ).rejects.toThrow("This path is protected by the host guardrail.");
  await expect(provider.listFiles(folderComputer, "control-plane", context)).rejects.toThrow(
    "This path is protected by the host guardrail.",
  );
  await expect(
    provider.writeFile(folderComputer, {
      path: "control-plane/secrets.env",
      content: new Uint8Array([1]),
    }),
  ).rejects.toThrow("This path is protected by the host guardrail.");
  // A path that merely shares the prefix is not caught.
  await mkdir(path.join(root, "control-plane-notes"));
  expect(await provider.listFiles(folderComputer, "control-plane-notes", context)).toEqual([]);
});

it("still reads and writes the computer's own files", async () => {
  const { provider, computer } = await fixture({ platform: "darwin" });
  await provider.writeFile(computer, { path: "notes.txt", content: new Uint8Array([65]) });
  expect([...(await provider.readFile(computer, "notes.txt", context))]).toEqual([65]);
  expect(fake.spawn).not.toHaveBeenCalled();
});
