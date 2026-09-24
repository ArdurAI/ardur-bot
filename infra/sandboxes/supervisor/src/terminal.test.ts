import { PassThrough } from "node:stream";
import { decodeTerminalFrame } from "@ardurbot/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRegistry } from "./terminal.js";
import type { TerminalProcess } from "./terminal-process.js";

const grant = {
  leaseId: "test-lease",
  fence: 1,
  generation: "test-container",
  expiresAt: 100_000,
  workingRoot: "/home/ardurbot",
  cols: 80,
  rows: 24,
  shellProfileId: "default",
};
function process() {
  const stream = new PassThrough({ highWaterMark: 64 * 1024 });
  return {
    stream,
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {
      stream.destroy();
    }),
  } satisfies TerminalProcess;
}
afterEach(() => vi.useRealTimers());
describe("Docker terminal registry", () => {
  it("atomically admits either a command or a terminal, never both", async () => {
    const registry = new TerminalRegistry(() => 1_000),
      p = process();
    let finish = () => {};
    const running = registry.command(
      "computer",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await expect(registry.open("computer", grant, async () => p)).rejects.toThrow("busy");
    finish();
    await running;
    const opening = registry.open("computer", grant, async () => p);
    await expect(registry.command("computer", async () => {})).rejects.toThrow("person");
    const session = await opening;
    await registry.close(session.id);
    await expect(registry.command("computer", async () => "resumed")).resolves.toBe("resumed");
  });
  it("rejects stale fences and generations and bounds source frames", async () => {
    const registry = new TerminalRegistry(() => 1_000),
      p = process();
    const session = await registry.open("computer", grant, async () => p);
    expect(() => registry.current(session.id, "computer", "replacement")).toThrow();
    expect(() => registry.current(session.id, "another")).toThrow();
    p.stream.write(Buffer.alloc(80 * 1024, 255));
    const one = decodeTerminalFrame((await registry.read(session.id, "computer"))!);
    const two = decodeTerminalFrame((await registry.read(session.id, "computer"))!);
    expect(one.bytes.length).toBe(65536);
    expect(two.seq).toBe(2);
    expect(two.bytes.length).toBe(16 * 1024);
    await registry.close(session.id);
    await expect(registry.open("computer", grant, async () => process())).rejects.toThrow("Stale");
  });
  it("fences input immediately and blocks commands until descendants die", async () => {
    const registry = new TerminalRegistry(() => 1_000),
      p = process();
    const session = await registry.open("computer", grant, async () => p);
    let dead = () => {};
    p.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          dead = resolve;
        }),
    );
    const cleanup = registry.revoke("computer", grant.leaseId);
    await Promise.resolve();
    expect(() => registry.current(session.id, "computer")).toThrow();
    await expect(registry.command("computer", async () => {})).rejects.toThrow();
    dead();
    await cleanup;
    await expect(registry.command("computer", async () => "resumed")).resolves.toBe("resumed");
    p.stream.destroy();
  });
  it("expiry terminates descendants and failed cleanup remains fenced", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const registry = new TerminalRegistry(() => now),
      p = process();
    const session = await registry.open("computer", { ...grant, expiresAt: 2_000 }, async () => p);
    p.close.mockRejectedValueOnce(new Error("cleanup failed"));
    now = 2_001;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(p.close).toHaveBeenCalled();
    await expect(registry.command("computer", async () => {})).rejects.toThrow();
    await registry.close(session.id);
    await expect(registry.command("computer", async () => "resumed")).resolves.toBe("resumed");
  });
  it("rejects profiles, invalid resizes and expired grants before creating a process", async () => {
    const registry = new TerminalRegistry(() => 1_000),
      spawn = vi.fn(async () => process());
    for (const changed of [
      { cols: 0 },
      { rows: 501 },
      { shellProfileId: "/bin/other" },
      { expiresAt: 999 },
    ])
      await expect(registry.open("computer", { ...grant, ...changed }, spawn)).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
});
