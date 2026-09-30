import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { type ChildOutputLogger, captureChildOutput } from "./child-output.js";

function fakeChild(script: string): ChildProcess {
  return spawn(process.execPath, ["-e", script], { stdio: "pipe" });
}

function fakeLogger() {
  const debug = vi.fn();
  const logger: ChildOutputLogger = { debug };
  return { logger, debug };
}

function closed(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("close", (code) => resolve(code)));
}

describe("captureChildOutput", () => {
  it("streams redacted lines to the debug log tagged with kind, pid and run id", async () => {
    const { logger, debug } = fakeLogger();
    const child = fakeChild('process.stderr.write("first line\\nkey=fixture-run-secret\\n");');
    const captured = captureChildOutput(child, {
      kind: "fixture",
      runId: "run-1",
      secrets: ["fixture-run-secret"],
      logger,
    });
    await closed(child);
    expect(debug).toHaveBeenCalledWith(
      "fixture stderr: first line",
      expect.objectContaining({ kind: "fixture", pid: child.pid, runId: "run-1" }),
    );
    expect(debug).toHaveBeenCalledWith(
      "fixture stderr: key=[redacted]",
      expect.objectContaining({ kind: "fixture" }),
    );
    captured.close();
  });

  it("redacts run secrets and token-shaped strings from the tail", async () => {
    const { logger } = fakeLogger();
    const child = fakeChild(
      'process.stderr.write("secret=fixture-run-secret\\nbearer sk-abcdef1234567890\\n");',
    );
    const captured = captureChildOutput(child, {
      kind: "fixture",
      secrets: ["fixture-run-secret"],
      logger,
    });
    await closed(child);
    const tail = captured.tail();
    expect(tail).not.toContain("fixture-run-secret");
    expect(tail).not.toContain("sk-abcdef1234567890");
    expect(tail).toContain("secret=[redacted]");
    expect(tail).toContain("bearer [redacted]");
    captured.close();
  });

  it("keeps a bounded tail: old lines drop, the last lines survive", async () => {
    const { logger } = fakeLogger();
    const child = fakeChild(
      `for (let i = 0; i < 200; i++) process.stderr.write(String(i).padStart(4, "0") + " " + "x".repeat(1024) + "\\n");`,
    );
    const captured = captureChildOutput(child, { kind: "fixture", logger });
    await closed(child);
    const tail = captured.tail();
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(64 * 1024 + 1100);
    expect(tail).toContain("0199");
    expect(tail).not.toContain("0000 ");
    captured.close();
  });

  it("captures stdout only when asked and flushes a trailing partial line", async () => {
    const { logger, debug } = fakeLogger();
    const child = fakeChild(
      'process.stdout.write("out\\npartial"); process.stderr.write("err\\n");',
    );
    const captured = captureChildOutput(child, { kind: "fixture", logger, captureStdout: true });
    await closed(child);
    const tail = captured.tail();
    expect(tail).toContain("out");
    expect(tail).toContain("partial");
    expect(tail).toContain("err");
    expect(debug).toHaveBeenCalledWith(
      "fixture stdout: out",
      expect.objectContaining({ kind: "fixture" }),
    );
    captured.close();
  });

  it("close() stops listening without losing the buffered tail", async () => {
    const { logger } = fakeLogger();
    const child = fakeChild('process.stderr.write("kept\\n"); setTimeout(() => {}, 500);');
    const captured = captureChildOutput(child, { kind: "fixture", logger });
    for (let i = 0; i < 50 && captured.tail() !== "kept"; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    captured.close();
    expect(captured.tail()).toBe("kept");
    child.kill("SIGKILL");
    await closed(child);
  });
});
