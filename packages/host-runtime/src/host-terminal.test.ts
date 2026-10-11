import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, TerminalContext } from "@ardurbot/adapter-kit";
import { TERMINAL_FRAME_BYTES } from "@ardurbot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostTerminalProcess } from "./host-terminal.js";
import { HostTerminalProvider } from "./host-terminal.js";

function fakeProcess() {
  let data: (bytes: Uint8Array) => void = () => {};
  let exit: () => void = () => {};
  return {
    write: vi.fn(),
    resize: vi.fn(),
    killTree: vi.fn(async () => {}),
    onData: vi.fn((listener: typeof data) => {
      data = listener;
      return () => {
        data = () => {};
      };
    }),
    onExit: vi.fn((listener: typeof exit) => {
      exit = listener;
      return () => {
        exit = () => {};
      };
    }),
    emit: (bytes: Uint8Array) => data(bytes),
    exit: () => exit(),
  };
}
const size = { cols: 80, rows: 24, shellProfileId: "default" };
let root: string;
const providers: HostTerminalProvider[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "host-terminal-test-")));
});
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.closeAll();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});
function fixture() {
  const processes: ReturnType<typeof fakeProcess>[] = [];
  const spawn = vi.fn(async () => {
    const process = fakeProcess();
    processes.push(process);
    return process as HostTerminalProcess;
  });
  const guard = {
    paths: [path.join(root, "protected")],
    ports: [12345],
    sockets: [path.join(root, "engine.sock")],
  };
  const factory = vi.fn(() => ({ spawn }));
  const provider = new HostTerminalProvider({
    factory,
    guard,
    environment: async () => ({
      PATH: "/fake/bin",
      HOME: root,
      PAIRING_TOKEN: "fake-pairing",
      SERVICE_API_KEY: "fake-secret",
      NODE_OPTIONS: "fake-injection",
    }),
  });
  providers.push(provider);
  const computer: ComputerRef = {
    id: "computer",
    botId: "bot",
    kind: "desktop",
    providerRef: root,
  };
  const context: TerminalContext = {
    userId: "owner",
    spaceId: "space",
    botId: "bot",
    operationId: "open",
    traceId: "open",
    signal: new AbortController().signal,
    leaseId: "lease",
    fence: 4,
    generation: root,
    expiresAt: Date.now() + 60000,
    workingRoot: root,
  };
  return { provider, processes, spawn, factory, guard, computer, context };
}

describe("host terminal process boundary", () => {
  it("kills an opened process when its bridge result cannot be delivered", async () => {
    const f = fixture();
    await expect(
      f.provider.call(
        f.computer,
        {
          type: "open",
          ...size,
          shellProfileId: "default",
          leaseId: f.context.leaseId,
          fence: f.context.fence,
          generation: f.context.generation,
          expiresAt: f.context.expiresAt,
          hostGeneration: f.provider.hostGeneration,
          workingRoot: root,
        },
        f.context,
        async () => {
          throw new Error("disconnected");
        },
      ),
    ).rejects.toThrow("disconnected");
    expect(f.processes[0]!.killTree).toHaveBeenCalledOnce();
  });
  it("filters environment, binds guards and forwards input, resize and bounded frames", async () => {
    const f = fixture();
    const opened = await f.provider.open(f.computer, size, f.context);
    expect(f.factory).toHaveBeenCalledExactlyOnceWith(f.guard);
    const env = (f.spawn.mock.calls[0] as unknown as [string, string, NodeJS.ProcessEnv])[2];
    expect(env).toEqual({ PATH: "/fake/bin", HOME: root, TERM: "xterm-256color" });
    await f.provider.write(opened.id, Uint8Array.of(1, 2));
    await f.provider.resize(opened.id, 100, 30);
    expect(f.processes[0]!.write).toHaveBeenCalledWith(Uint8Array.of(1, 2));
    expect(f.processes[0]!.resize).toHaveBeenCalledWith(100, 30);
    const output = f.provider.output(opened.id)[Symbol.asyncIterator]();
    f.processes[0]!.emit(new Uint8Array(TERMINAL_FRAME_BYTES + 1));
    expect((await output.next()).value).toMatchObject({
      seq: 1,
      bytes: new Uint8Array(TERMINAL_FRAME_BYTES),
    });
    expect((await output.next()).value).toEqual({ seq: 2, bytes: Uint8Array.of(0) });
    await f.provider.close(opened.id, "closed");
    expect(f.processes[0]!.killTree).toHaveBeenCalledOnce();
    await expect(output.next()).resolves.toMatchObject({ done: true });
    await expect(f.provider.write(opened.id, Uint8Array.of(1))).rejects.toThrow();
  });
  it("refuses symlink escapes, protected cwd and stale or expired grants before spawn", async () => {
    const f = fixture();
    await mkdir(path.join(root, "workspace"));
    await mkdir(path.join(root, "outside"));
    await symlink(path.join(root, "outside"), path.join(root, "workspace", "escape"));
    await mkdir(path.join(root, "protected"));
    await expect(
      f.provider.open({ ...f.computer, providerRef: path.join(root, "workspace") }, size, {
        ...f.context,
        generation: path.join(root, "workspace"),
        workingRoot: path.join(root, "workspace", "escape"),
      }),
    ).rejects.toThrow("Path escapes");
    await expect(
      f.provider.open(f.computer, size, {
        ...f.context,
        workingRoot: path.join(root, "protected"),
      }),
    ).rejects.toThrow("protected");
    await expect(
      f.provider.open(f.computer, size, { ...f.context, generation: "stale" }),
    ).rejects.toThrow();
    await expect(
      f.provider.open(f.computer, size, { ...f.context, expiresAt: Date.now() - 1 }),
    ).rejects.toThrow();
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("reserves four concurrent admissions and refuses conflicting grants", async () => {
    const f = fixture();
    const opened = await Promise.all(
      Array.from({ length: 4 }, () => f.provider.open(f.computer, size, f.context)),
    );
    await expect(f.provider.open(f.computer, size, f.context)).rejects.toThrow();
    await f.provider.close(opened[0]!.id, "closed");
    await expect(f.provider.open(f.computer, size, { ...f.context, fence: 5 })).rejects.toThrow();
    expect(f.spawn).toHaveBeenCalledTimes(4);
  });
  it.each(["close", "revoke", "disconnect", "expiry", "process-exit", "output-limit"])(
    "kills the tree on %s",
    async (reason) => {
      vi.useFakeTimers();
      const f = fixture();
      const opened = await f.provider.open(f.computer, size, f.context);
      if (reason === "close") await f.provider.close(opened.id, reason);
      else if (reason === "revoke")
        await f.provider.revoke(f.computer, f.context.leaseId, f.context);
      else if (reason === "disconnect") await f.provider.closeAll();
      else if (reason === "expiry") await vi.advanceTimersByTimeAsync(60001);
      else if (reason === "process-exit") f.processes[0]!.exit();
      else for (let i = 0; i < 257; i++) f.processes[0]!.emit(Uint8Array.of(1));
      await vi.waitFor(() => expect(f.processes[0]!.killTree).toHaveBeenCalledOnce());
      await expect(f.provider.write(opened.id, Uint8Array.of(1))).rejects.toThrow();
    },
  );
  it.each(["revoke", "disconnect", "abort", "expiry"])(
    "awaits a pending spawn during %s",
    async (reason) => {
      const f = fixture();
      const process = fakeProcess();
      const controller = new AbortController();
      let resolveSpawn!: (process: HostTerminalProcess) => void;
      f.spawn.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSpawn = resolve;
          }),
      );
      const context = { ...f.context, signal: controller.signal };
      const opening = f.provider.open(f.computer, size, context);
      const failed = expect(opening).rejects.toThrow();
      await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
      let finished = false;
      const cleanup =
        reason === "revoke"
          ? f.provider.revoke(f.computer, context.leaseId, context)
          : reason === "disconnect"
            ? f.provider.closeAll()
            : Promise.resolve();
      if (reason === "abort") controller.abort();
      if (reason === "expiry") {
        vi.useFakeTimers();
        vi.setSystemTime(context.expiresAt + 1);
      }
      void cleanup.then(() => {
        finished = true;
      });
      if (reason === "revoke" || reason === "disconnect") {
        await Promise.resolve();
        expect(finished).toBe(false);
      }
      resolveSpawn(process);
      await failed;
      await cleanup;
      expect(process.killTree).toHaveBeenCalledOnce();
    },
  );
  it("remembers revocation that arrives before open", async () => {
    const f = fixture();
    await f.provider.revoke(f.computer, f.context.leaseId, f.context);
    await expect(f.provider.open(f.computer, size, f.context)).rejects.toThrow();
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("does not release a session or admit another while tree cleanup fails", async () => {
    const f = fixture();
    const opened = await f.provider.open(f.computer, size, f.context);
    f.processes[0]!.killTree.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(f.provider.close(opened.id, "close")).rejects.toThrow("cleanup failed");
    await expect(f.provider.open(f.computer, size, f.context)).rejects.toThrow();
    await f.provider.close(opened.id, "retry");
    expect(f.processes[0]!.killTree).toHaveBeenCalledTimes(2);
  });
  it("refuses stale host generations and cross-owner session frames", async () => {
    const f = fixture();
    const opened = await f.provider.open(f.computer, size, f.context);
    const action = {
      type: "write" as const,
      sessionId: opened.id,
      content: "AQ==",
      leaseId: f.context.leaseId,
      fence: f.context.fence,
      generation: f.context.generation,
      expiresAt: f.context.expiresAt,
      hostGeneration: f.provider.hostGeneration,
    };
    await expect(
      f.provider.call(f.computer, { ...action, hostGeneration: "stale" }, f.context, vi.fn()),
    ).rejects.toThrow();
    await expect(
      f.provider.call(f.computer, action, { ...f.context, userId: "member" }, vi.fn()),
    ).rejects.toThrow();
    await expect(
      f.provider.call(f.computer, { ...action, fence: 5 }, f.context, vi.fn()),
    ).rejects.toThrow();
    expect(f.processes[0]!.write).not.toHaveBeenCalled();
  });
});
