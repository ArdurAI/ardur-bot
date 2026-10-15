import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, TerminalContext } from "@ardurbot/adapter-kit";
import { computerCapabilities } from "@ardurbot/contracts";
import type { HostHealth } from "@ardurbot/contracts/host-bridge";
import { HostOperationSchema } from "@ardurbot/contracts/host-bridge";
import type { HostTerminalProcess } from "@ardurbot/host-runtime/host-terminal";
import { HostTerminalProvider } from "@ardurbot/host-runtime/host-terminal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteHostSandboxProvider } from "./remote-host-sandbox.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "remote-terminal-test-")));
  let emit: (bytes: Uint8Array) => void = () => {};
  const process = {
    write: vi.fn(),
    resize: vi.fn(),
    killTree: vi.fn(async () => {}),
    onData: (listener: typeof emit) => {
      emit = listener;
      return () => {};
    },
    onExit: () => () => {},
  };
  const spawn = vi.fn(async () => process as HostTerminalProcess);
  const host = new HostTerminalProvider({
    factory: () => ({ spawn }),
    guard: { paths: [], ports: [], sockets: [] },
    environment: async () => ({}),
    generation: (computer) => `host:${computer.botId}`,
  });
  let advertised = true;
  const computer: ComputerRef = {
    id: "computer",
    kind: "desktop",
    botId: "home",
    providerRef: "host:home",
  };
  const context: TerminalContext = {
    userId: "owner",
    spaceId: "space",
    botId: "bot",
    signal: new AbortController().signal,
    operationId: "terminal",
    traceId: "terminal",
    leaseId: "lease",
    fence: 1,
    generation: "host:home",
    expiresAt: Date.now() + 60000,
    workingRoot: root,
  };
  const operations: unknown[] = [];
  const client = {
    health: async () =>
      ({
        capabilities: advertised
          ? { providerRelay: 1, hostTerminal: { generation: host.hostGeneration } }
          : { providerRelay: 1 },
      }) as HostHealth,
    result: async (value: unknown) => {
      const op = HostOperationSchema.parse(value);
      operations.push(op);
      if (op.op !== "computer.terminal") throw new Error("Unexpected operation");
      let result: unknown;
      await host.call(
        { ...computer, providerRef: root },
        op.action,
        context,
        async (_channel, data) => {
          result = data;
        },
      );
      return result;
    },
    async *request(value: unknown) {
      const op = HostOperationSchema.parse(value);
      if (op.op !== "computer.terminal" || op.action.type !== "output")
        throw new Error("Unexpected stream");
      for await (const frame of host.output(op.action.sessionId))
        yield {
          v: 1 as const,
          type: "stream" as const,
          id: "output",
          seq: frame.seq,
          channel: "result" as const,
          data: { seq: frame.seq, content: Buffer.from(frame.bytes).toString("base64") },
        };
    },
  };
  const sandbox = new RemoteHostSandboxProvider(client);
  cleanup.push(async () => {
    await host.closeAll();
    await rm(root, { recursive: true, force: true });
  });
  return {
    host,
    sandbox,
    computer,
    context,
    process,
    spawn,
    operations,
    emit: (bytes: Uint8Array) => emit(bytes),
    advertise: (value: boolean) => {
      advertised = value;
    },
  };
}
describe("host terminal forwarding", () => {
  it("uses a control grant for cwd, input, resize and cleanup without a bot run", async () => {
    const f = await fixture();
    expect(computerCapabilities("desktop").interactiveTerminal).toBe(false);
    expect(f.sandbox.describe().capabilities.pty).toBe(false);
    expect(await f.sandbox.terminal.available!(f.computer, f.context)).toBe(true);
    expect(await f.sandbox.resolveCommandCwd(f.computer, undefined, f.context)).toBe(
      f.context.workingRoot,
    );
    const opened = await f.sandbox.terminal.open(
      f.computer,
      { cols: 80, rows: 24, shellProfileId: "default" },
      f.context,
    );
    await f.sandbox.terminal.write(opened.id, Uint8Array.of(1));
    await f.sandbox.terminal.resize(opened.id, 100, 30);
    const output = f.sandbox.terminal.output(opened.id)[Symbol.asyncIterator]();
    const next = output.next();
    f.emit(Uint8Array.of(2, 3));
    expect((await next).value).toEqual({ seq: 1, bytes: Buffer.from([2, 3]) });
    await f.sandbox.terminal.close(opened.id, "close");
    await f.sandbox.terminal.close(opened.id, "close");
    expect(f.process.write).toHaveBeenCalledWith(Buffer.from([1]));
    expect(f.process.resize).toHaveBeenCalledWith(100, 30);
    expect(f.process.killTree).toHaveBeenCalledOnce();
    expect(f.operations).toHaveLength(5);
    f.advertise(false);
    expect(await f.sandbox.terminal.available!(f.computer, f.context)).toBe(false);
    await expect(
      f.sandbox.terminal.open(
        f.computer,
        { cols: 80, rows: 24, shellProfileId: "default" },
        f.context,
      ),
    ).rejects.toThrow();
    expect(f.spawn).toHaveBeenCalledOnce();
  });
  it("forwards revoke while a remote open is pending and waits for tree cleanup", async () => {
    const f = await fixture();
    let spawned!: (process: HostTerminalProcess) => void;
    f.spawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          spawned = resolve;
        }),
    );
    const opening = f.sandbox.terminal.open(
      f.computer,
      { cols: 80, rows: 24, shellProfileId: "default" },
      f.context,
    );
    const failed = expect(opening).rejects.toThrow();
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    let released = false;
    const revoke = f.sandbox.terminal.revoke(f.computer, "lease", f.context).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    spawned(f.process);
    await failed;
    await revoke;
    expect(f.process.killTree).toHaveBeenCalledOnce();
    expect(f.process.write).not.toHaveBeenCalled();
  });
});
