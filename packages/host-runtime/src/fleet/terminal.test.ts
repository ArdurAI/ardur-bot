import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ComputerRef, TerminalContext } from "@ardurbot/adapter-kit";
import { TERMINAL_FRAME_BYTES } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { FleetTerminal } from "./terminal.js";

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(() => {
      child.exitCode = 0;
      child.emit("close", 0);
      return true;
    }),
  });
  const cleanup = vi.fn(async () => {});
  const start = vi.fn(async () => ({
    child: child as unknown as ChildProcessWithoutNullStreams,
    cleanup,
  }));
  const terminal = new FleetTerminal(start, async () => "/workspace");
  const computer: ComputerRef = {
    id: "computer-test",
    providerRef: "computer-test",
    botId: "bot-test",
    kind: "ssh",
  };
  const context: TerminalContext = {
    operationId: "terminal.open",
    traceId: "terminal.open",
    spaceId: "space-test",
    userId: "user-test",
    signal: new AbortController().signal,
    leaseId: "lease-test",
    fence: 1,
    generation: "generation-test",
    expiresAt: Date.now() + 60_000,
    workingRoot: "/workspace/bots/bot-test",
  };
  return { terminal, child, cleanup, start, computer, context };
}

describe("Fleet terminal protocol", () => {
  it("caps siblings and closes one without ending another child", async () => {
    const f = fixture();
    const children: ReturnType<typeof fixture>["child"][] = [];
    f.start.mockImplementation(async () => {
      const other = fixture();
      children.push(other.child);
      return {
        child: other.child as unknown as ChildProcessWithoutNullStreams,
        cleanup: other.cleanup,
      };
    });
    try {
      const sessions = await Promise.all(
        Array.from({ length: 4 }, () =>
          f.terminal.open(f.computer, { cols: 80, rows: 24, shellProfileId: "default" }, f.context),
        ),
      );
      await expect(
        f.terminal.open(f.computer, { cols: 80, rows: 24, shellProfileId: "default" }, f.context),
      ).rejects.toThrow();
      await f.terminal.close(sessions[1]!.id, "closed");
      expect(children[1]!.kill).toHaveBeenCalledOnce();
      expect(children[0]!.kill).not.toHaveBeenCalled();
      await f.terminal.write(sessions[0]!.id, Uint8Array.of(1));
      await expect(
        f.terminal.open(
          f.computer,
          { cols: 80, rows: 24, shellProfileId: "default" },
          { ...f.context, userId: "other" },
        ),
      ).rejects.toThrow();
      await expect(
        f.terminal.open(
          f.computer,
          { cols: 80, rows: 24, shellProfileId: "default" },
          { ...f.context, generation: "other" },
        ),
      ).rejects.toThrow();
    } finally {
      await f.terminal.closeAll();
    }
  });
  it("numbers the prompt and subsequent binary output from one across split child chunks", async () => {
    const f = fixture();
    const session = await f.terminal.open(
      f.computer,
      { cols: 80, rows: 24, shellProfileId: "default" },
      f.context,
    );
    try {
      const bytes = [Buffer.from("你好 🧪 $ "), Buffer.from([0, 128, 255, 27])];
      const lines = bytes
        .map((value) => `${JSON.stringify({ bytes: value.toString("base64") })}\n`)
        .join("");
      f.child.stdout.write(lines.slice(0, 7));
      f.child.stdout.write(lines.slice(7));
      const output = f.terminal.output(session.id)[Symbol.asyncIterator]();
      expect((await output.next()).value).toEqual({ seq: 1, bytes: bytes[0] });
      expect((await output.next()).value).toEqual({ seq: 2, bytes: bytes[1] });
    } finally {
      await f.terminal.close(session.id, "test-ended");
      await f.terminal.close(session.id, "test-ended");
    }
    expect(f.child.kill).toHaveBeenCalledOnce();
    expect(f.cleanup).toHaveBeenCalledOnce();
  });

  it("accepts the shared input boundary byte-for-byte and refuses oversize input before writing", async () => {
    const f = fixture();
    const session = await f.terminal.open(
      f.computer,
      { cols: 80, rows: 24, shellProfileId: "default" },
      f.context,
    );
    const write = vi.spyOn(f.child.stdin, "write");
    try {
      for (const bytes of [
        Buffer.from("你好 🧪\r\n"),
        Buffer.from([0, 128, 255, 27]),
        Buffer.alloc(TERMINAL_FRAME_BYTES, 255),
      ]) {
        await f.terminal.write(session.id, bytes);
        const line = String(write.mock.calls.at(-1)![0]);
        expect(Buffer.from(JSON.parse(line).bytes, "base64")).toEqual(bytes);
        expect(line.endsWith("\n")).toBe(true);
      }
      expect(write).toHaveBeenCalledTimes(3);
      await expect(
        f.terminal.write(session.id, new Uint8Array(TERMINAL_FRAME_BYTES + 1)),
      ).rejects.toThrow("Terminal input exceeds limit.");
      expect(write).toHaveBeenCalledTimes(3);
      await f.terminal.revoke(f.computer, f.context.leaseId, f.context);
      await expect(f.terminal.write(session.id, Uint8Array.of(1))).rejects.toThrow("lease");
      expect(write).toHaveBeenCalledTimes(3);
    } finally {
      await f.terminal.closeAll();
    }
    expect(f.cleanup).toHaveBeenCalledOnce();
  });
});
