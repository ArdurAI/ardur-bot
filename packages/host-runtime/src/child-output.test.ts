import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  type ChildOutputLogger,
  captureChildOutput,
  createChildProcessLogger,
} from "./child-output.js";

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
  it("drains a real child even when the fallback sink never drains", async () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const sink = new Writable({ highWaterMark: 1, write() {} });
    const logger = createChildProcessLogger(sink);
    const child = fakeChild(
      'for (let i = 0; i < 100000; i++) process.stderr.write("fixture line\\n");',
    );
    const captured = captureChildOutput(child, { kind: "fixture", logger });
    try {
      expect(await closed(child)).toBe(0);
      expect(sink.writableLength).toBeLessThan(1024);
      expect(Buffer.byteLength(captured.tail())).toBeLessThanOrEqual(64 * 1024);
    } finally {
      captured.close();
      sink.destroy();
      vi.unstubAllEnvs();
    }
  });

  it("reports the bounded queue's dropped count once after recovery", async () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const write = vi.spyOn(sink, "write").mockReturnValue(false);
    const logger = createChildProcessLogger(sink);
    try {
      logger.debug("first");
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (let i = 0; i < 1000; i++) logger.debug("fixture line");
      expect(write).toHaveBeenCalledTimes(1);
      write.mockReturnValue(true);
      sink.emit("drain");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const records = write.mock.calls.map(([line]) => JSON.parse(String(line)));
      const summaries = records.filter((record) => record.droppedLines !== undefined);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].droppedLines).toBe(872);
      expect(records).toHaveLength(130);
    } finally {
      write.mockRestore();
      sink.destroy();
      vi.unstubAllEnvs();
    }
  });

  it.each([true, false])(
    "bounds a lazily generated 100 MiB line (newline: %s)",
    async (newline) => {
      const stderr = Readable.from(
        (function* () {
          const chunk = Buffer.alloc(100 * 1024 * 1024, "x");
          if (newline) chunk[chunk.length - 1] = 10;
          yield chunk;
        })(),
      );
      const child = { stderr, stdout: null, pid: 123 } as unknown as ChildProcess;
      let maxLoggedBytes = 0;
      const captured = captureChildOutput(child, {
        kind: "fixture",
        logger: {
          debug: (line) => {
            maxLoggedBytes = Math.max(maxLoggedBytes, Buffer.byteLength(line));
          },
        },
      });
      await new Promise<void>((resolve) => stderr.once("end", resolve));
      expect(captured.tail()).toBe("Output line exceeded the size limit.");
      expect(Buffer.byteLength(captured.tail())).toBeLessThanOrEqual(64 * 1024);
      expect(maxLoggedBytes).toBeLessThanOrEqual(8 * 1024);
      captured.close();
    },
  );

  it("enforces byte limits for multibyte lines too", async () => {
    const { logger, debug } = fakeLogger();
    const child = fakeChild('process.stderr.write("界".repeat(4000) + "\\nlast\\n");');
    const captured = captureChildOutput(child, { kind: "fixture", logger });
    await closed(child);
    expect(captured.tail()).toBe("Output line exceeded the size limit.\nlast");
    expect(JSON.stringify(debug.mock.calls)).not.toContain("界");
    captured.close();
  });

  it("serializes real Error causes through the production fallback", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      createChildProcessLogger().error?.(
        "Fixture process failed",
        new Error("Outer failure", {
          cause: new Error("phase: prompt; exit: 4; durationMs: 12", {
            cause: new Error("token=synthetic-secret"),
          }),
        }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const record = JSON.parse(String(write.mock.calls[0]?.[0]));
      expect(record.error.cause.message).toContain("phase: prompt; exit: 4; durationMs: 12");
      expect(record.error.cause.cause.message).toBe("token=[Redacted]");
      expect(JSON.stringify(record)).not.toContain("synthetic-secret");
    } finally {
      write.mockRestore();
    }
  });

  it.each([
    ['{"PASSWORD":"alpha beta gamma"}', "alpha beta gamma"],
    ['{"aPi_KeY":"alpha beta gamma"}', "alpha beta gamma"],
    ["cookie='alpha beta gamma'", "alpha beta gamma"],
    ["ghp_fixtureSyntheticToken123456789", "ghp_fixtureSyntheticToken123456789"],
    ["gho_fixtureSyntheticToken123456789", "gho_fixtureSyntheticToken123456789"],
    ["ghu_fixtureSyntheticToken123456789", "ghu_fixtureSyntheticToken123456789"],
    ["ghs_fixtureSyntheticToken123456789", "ghs_fixtureSyntheticToken123456789"],
    ["ghr_fixtureSyntheticToken123456789", "ghr_fixtureSyntheticToken123456789"],
    ["AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
    ["aB1/".repeat(10), "aB1/".repeat(10)],
    ["sk-fixtureSyntheticKey123456789", "sk-fixtureSyntheticKey123456789"],
    ["xai-fixtureSyntheticKey123456789", "xai-fixtureSyntheticKey123456789"],
    [
      "eyJmaXh0dXJlIjoxfQ.eyJmaXh0dXJlIjoyfQ.syntheticSignature",
      "eyJmaXh0dXJlIjoxfQ.eyJmaXh0dXJlIjoyfQ.syntheticSignature",
    ],
    ["Bearer fixtureOpaqueValue", "fixtureOpaqueValue"],
  ])("redacts a credential shape from tail and debug: %s", async (line, secret) => {
    const { logger, debug } = fakeLogger();
    const child = fakeChild(`process.stderr.write(${JSON.stringify(`${line}\n`)});`);
    const captured = captureChildOutput(child, { kind: "fixture", logger });
    await closed(child);
    expect(captured.tail()).toContain("[redacted]");
    expect(captured.tail()).not.toContain(secret);
    expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
    if (secret.includes(" ")) expect(captured.tail()).not.toContain("beta gamma");
    captured.close();
  });

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
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(64 * 1024);
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
