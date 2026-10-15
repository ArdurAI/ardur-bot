import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  encodeTerminalFrame,
  TERMINAL_FRAME_BYTES,
  TERMINAL_GRACE_MS,
  TERMINAL_REPLAY_BYTES,
} from "@ardurbot/contracts";
import { HostTerminalProvider } from "@ardurbot/host-runtime/host-terminal";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalGrant, TerminalSocket } from "./terminal-gateway.js";
import { TerminalGateway } from "./terminal-gateway.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.useRealTimers();
});
async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "terminal-host-test-")));
  let output: (bytes: Uint8Array) => void = () => {};
  const process = {
    write: vi.fn(),
    resize: vi.fn(),
    killTree: vi.fn(async () => {}),
    onData: (listener: typeof output) => {
      output = listener;
      return () => {};
    },
    onExit: () => () => {},
  };
  const spawn = vi.fn(async () => process);
  const provider = new HostTerminalProvider({
    factory: () => ({ spawn }),
    guard: { paths: [], ports: [], sockets: [] },
    environment: async () => ({}),
  });
  const grant: TerminalGrant = {
    actor: { userId: "owner", spaceId: "space", role: "owner" },
    botId: "bot",
    computerId: "computer",
    computerGeneration: 1,
    authSessionId: "auth",
    releaseOnDisconnect: true,
    computer: { id: "computer", botId: "bot", providerRef: root, kind: "desktop" },
    context: {
      userId: "owner",
      spaceId: "space",
      botId: "bot",
      operationId: "open",
      traceId: "open",
      signal: new AbortController().signal,
      leaseId: "lease",
      fence: 2,
      generation: root,
      expiresAt: 100000,
      workingRoot: root,
    },
  };
  const authorize = vi.fn(async (_grant: TerminalGrant) => {});
  const disconnected = vi.fn(async () => {});
  const gateway = new TerminalGateway({
    provider,
    authorize,
    disconnected,
    audit: async () => {},
    now: Date.now,
  });
  const socket: TerminalSocket = { send: vi.fn(async () => {}), close: vi.fn() };
  cleanup.push(async () => {
    await gateway.stop();
    await provider.closeAll();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    grant,
    process,
    spawn,
    provider,
    gateway,
    socket,
    disconnected,
    authorize,
    emit: (bytes: Uint8Array) => output(bytes),
  };
}
async function tick() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
describe("host processes through the terminal gateway", () => {
  it("consumes tickets once, expires unused tickets and never forwards their input", async () => {
    const f = await fixture();
    const ticket = await f.gateway.request(f.grant, "https://app.example");
    const attached = await f.gateway.attach(ticket.ticket, "https://app.example", 0, f.socket);
    await expect(
      f.gateway.attach(ticket.ticket, "https://app.example", 0, f.socket),
    ).rejects.toThrow();
    await attached.receive(encodeTerminalFrame(1, Uint8Array.of(1)));
    expect(f.process.write).toHaveBeenCalledOnce();
    attached.detach();
    const next = await f.gateway.request(f.grant, "https://app.example", ticket.sessionId);
    await vi.advanceTimersByTimeAsync(15001);
    await expect(
      f.gateway.attach(next.ticket, "https://app.example", 0, f.socket),
    ).rejects.toThrow();
    expect(f.process.write).toHaveBeenCalledOnce();
  });
  it("reconnects within grace and kills the tree before releasing disconnected control", async () => {
    const f = await fixture();
    const first = await f.gateway.request(f.grant, "https://app.example");
    const attached = await f.gateway.attach(first.ticket, "https://app.example", 0, f.socket);
    await attached.receive(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    await vi.advanceTimersByTimeAsync(100);
    expect(f.process.resize).toHaveBeenCalledWith(100, 30);
    attached.detach();
    await vi.advanceTimersByTimeAsync(5000);
    const next = await f.gateway.request(f.grant, "https://app.example", first.sessionId);
    const resumed = await f.gateway.attach(next.ticket, "https://app.example", 0, f.socket);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.process.killTree).not.toHaveBeenCalled();
    let killed!: () => void;
    f.process.killTree.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          killed = resolve;
        }),
    );
    resumed.detach();
    await vi.advanceTimersByTimeAsync(TERMINAL_GRACE_MS + 1);
    expect(f.process.killTree).toHaveBeenCalledOnce();
    expect(f.disconnected).not.toHaveBeenCalled();
    killed();
    await tick();
    expect(f.disconnected).toHaveBeenCalledOnce();
  });
  it("rejects a stale generation before spawn and kills a revoked opening process", async () => {
    const f = await fixture();
    await expect(
      f.gateway.request(
        { ...f.grant, context: { ...f.grant.context, generation: "stale" } },
        "https://app.example",
      ),
    ).rejects.toThrow();
    expect(f.spawn).not.toHaveBeenCalled();
    f.authorize.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error("revoked"));
    await expect(f.gateway.request(f.grant, "https://app.example")).rejects.toThrow();
    expect(f.process.killTree).toHaveBeenCalledOnce();
    expect(f.process.write).not.toHaveBeenCalled();
  });
  it("bounds replay and ends a process whose unread output exceeds the limit", async () => {
    const f = await fixture();
    await f.gateway.request(f.grant, "https://app.example");
    for (let i = 0; i <= TERMINAL_REPLAY_BYTES / TERMINAL_FRAME_BYTES; i++) {
      f.emit(new Uint8Array(TERMINAL_FRAME_BYTES));
      await tick();
    }
    await tick();
    expect(f.process.killTree).toHaveBeenCalledOnce();
    expect([...f.gateway.sessions.values()][0]!.retained).toBeLessThanOrEqual(
      TERMINAL_REPLAY_BYTES,
    );
    // A reader paused for acknowledgements observes termination when disconnect grace ends.
    await vi.advanceTimersByTimeAsync(TERMINAL_GRACE_MS + 1);
    expect(f.gateway.sessions.size).toBe(0);
  });
  it("kills the tree when lease authorization is lost before input", async () => {
    const f = await fixture();
    const ticket = await f.gateway.request(f.grant, "https://app.example");
    const attached = await f.gateway.attach(ticket.ticket, "https://app.example", 0, f.socket);
    f.authorize.mockRejectedValueOnce(new Error("lease lost"));
    await expect(attached.receive(encodeTerminalFrame(1, Uint8Array.of(1)))).rejects.toThrow();
    expect(f.process.write).not.toHaveBeenCalled();
    expect(f.process.killTree).toHaveBeenCalledOnce();
  });
});
