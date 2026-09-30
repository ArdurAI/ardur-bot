import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../logging/src/logger.js";
import { createTestSink } from "../../logging/src/test-sink.js";
import type { ChildOutputLogger } from "./child-output.js";
import { captureChildOutput, createChildProcessLogger } from "./child-output.js";

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
  beforeEach(() => vi.stubEnv("ARDUR_DETAILED_PROCESS_LOGS", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "0", "true"])(
    "keeps both output streams and tails out of every sink without explicit opt-in (%s)",
    async (optIn) => {
      vi.stubEnv("ARDUR_DETAILED_PROCESS_LOGS", optIn);
      vi.stubEnv("LOG_LEVEL", "debug");
      const secret = "made-up-unrecognized-credential";
      const prompt = "Please summarize the imaginary quarterly plan.";
      const file = "Imaginary document line: the launch is next week.";
      const output = `${secret}\n${prompt}\n${file}`;
      const sink = createTestSink();
      const logger = createLogger({ service: "fixture", level: "debug", sinks: [sink] });
      const fallbackRecords: string[] = [];
      const writable = new Writable({
        write(chunk, _encoding, done) {
          fallbackRecords.push(String(chunk));
          done();
        },
      });
      const fallback = createChildProcessLogger(writable);
      fallback.debug(output, { private_key: secret });
      const child = fakeChild(
        `process.stdout.write(${JSON.stringify(output)}); process.stderr.write(${JSON.stringify(output)}); process.exitCode = 4;`,
      );
      const debug = vi.fn((message: string, bindings?: Record<string, unknown>) => {
        logger.debug(message, bindings);
        fallback.debug(message, bindings);
      });
      const captured = captureChildOutput(child, {
        kind: "fixture",
        runId: "run-1",
        logger: { debug },
        captureStdout: true,
      });
      expect(await closed(child)).toBe(4);
      expect(captured.facts()).toMatchObject({
        kind: "fixture",
        pid: child.pid,
        runId: "run-1",
        byteCount: Buffer.byteLength(output) * 2,
        lineCount: 6,
        outputProduced: true,
      });
      const failure = new Error("Fixture process failed", { cause: captured.facts() });
      logger.error("Fixture process failed", failure);
      fallback.error?.("Fixture process failed", failure);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const records = JSON.stringify(sink.events) + fallbackRecords.join("");
      for (const content of [secret, prompt, file]) expect(records).not.toContain(content);
      expect(debug).not.toHaveBeenCalled();
      expect(captured.tail()).toBe("");
      captured.close();
      expect(captured.tail()).toBe("");
      writable.destroy();
    },
  );

  it.each([
    "access_token=Basic fixture-scheme-credential",
    "Authorization: Bearer dGVzdDp0ZXN0==",
    "access_token=Bearer dGVzdDp0ZXN0==",
    "Authorization: Bearer user:pass-part",
    "authKey=madeup-authKey-value",
    "auth_key=madeup-authKey-value",
    `github_pat_${"fixture123".repeat(10)}_fixture456`,
  ])("redacts detailed process output for the review reproduction %s", async (line) => {
    const { logger, debug } = fakeLogger();
    const child = fakeChild(`process.stderr.write(${JSON.stringify(`${line}\n`)});`);
    const captured = captureChildOutput(child, { kind: "fixture", logger });
    await closed(child);
    const diagnostics = captured.tail() + JSON.stringify(debug.mock.calls);
    expect(diagnostics).toContain("[redacted]");
    expect(diagnostics).not.toContain("fixture-scheme-credential");
    expect(diagnostics).not.toContain("fixture123");
    expect(diagnostics).not.toContain("Basic");
    expect(diagnostics).not.toContain("dGVzdDp0ZXN0==");
    expect(diagnostics).not.toContain("user:pass-part");
    expect(diagnostics).not.toContain("madeup-authKey-value");
    captured.close();
  });

  it.each(["running", "ended", "closed"])(
    "re-redacts the whole detailed tail when a credential is acquired after output (%s)",
    async (state) => {
      const { logger } = fakeLogger();
      const stderr = new PassThrough();
      const stdout = new PassThrough();
      const child = { stderr, stdout, pid: 123 } as unknown as ChildProcess;
      const secrets: string[] = [];
      const credential = "late-acquired-bridge-key-112233";
      const captured = captureChildOutput(child, {
        kind: "fixture",
        logger,
        secrets,
        captureStdout: true,
      });
      stderr.write(`${credential}\n`);
      stdout.write(`${credential.slice(0, 15)}\r\n${credential.slice(15)}\n`);
      if (state === "ended") {
        const ended = Promise.all(
          [stderr, stdout].map(
            (stream) => new Promise<void>((resolve) => stream.once("end", resolve)),
          ),
        );
        stderr.end();
        stdout.end();
        await ended;
      } else if (state === "closed") captured.close();
      expect(captured.tail()).toContain(credential);
      const facts = captured.facts();
      secrets.push(credential);
      expect(captured.tail()).toContain("[redacted]");
      expect(captured.tail()).not.toContain(credential);
      expect(captured.tail()).not.toContain(credential.slice(0, 15));
      expect(captured.tail()).not.toContain(credential.slice(15));
      expect(captured.facts()).toEqual(facts);
      secrets.length = 0;
      expect(captured.tail()).not.toContain(credential);
      captured.close();
      stderr.destroy();
      stdout.destroy();
    },
  );

  it("refreshes the tail for same-length secret-list changes and keeps its byte bounds", () => {
    const { logger } = fakeLogger();
    const stderr = new PassThrough();
    const secrets = ["old-fixture-credential"];
    const captured = captureChildOutput({ stderr } as unknown as ChildProcess, {
      kind: "fixture",
      logger,
      secrets,
    });
    stderr.write(`${"~".repeat(4000)}\n`.repeat(20));
    captured.close();
    secrets[0] = "~";
    expect(captured.tail()).not.toContain("~");
    expect(Buffer.byteLength(captured.tail())).toBeLessThanOrEqual(64 * 1024);
    stderr.destroy();
  });

  it.each(["", "\n", "\r\n"])(
    "redacts known credentials across chunks and physical lines (%j)",
    async (separator) => {
      const { logger, debug } = fakeLogger();
      const stderr = new PassThrough();
      const child = { stderr, stdout: null, pid: 123 } as unknown as ChildProcess;
      const secret = "opaque-first-half-second-half";
      const first = secret.slice(0, 17);
      const second = secret.slice(17);
      const captured = captureChildOutput(child, { kind: "fixture", logger, secrets: [secret] });
      stderr.write(`before\n${first}${separator}`);
      expect(JSON.stringify(debug.mock.calls)).not.toContain(first);
      stderr.end(`${second}\nafter\n`);
      await new Promise<void>((resolve) => stderr.once("end", resolve));
      const records = captured.tail() + JSON.stringify(debug.mock.calls);
      expect(records).toContain("[redacted]");
      expect(records).toContain("after");
      for (const fragment of [secret, first, second]) expect(records).not.toContain(fragment);
      captured.close();
    },
  );

  it("redacts encoded multiline credentials before line framing", async () => {
    const { logger, debug } = fakeLogger();
    const secret = "fixture-part-one\nfixture-part-two";
    const spellings = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
    const stderr = Readable.from(
      spellings.flatMap((spelling) => [
        Buffer.from(spelling.slice(0, 10)),
        Buffer.from(`${spelling.slice(10)}\n`),
      ]),
    );
    const captured = captureChildOutput({ stderr, stdout: null } as unknown as ChildProcess, {
      kind: "fixture",
      logger,
      secrets: [secret],
    });
    await new Promise<void>((resolve) => stderr.once("end", resolve));
    const records = captured.tail() + JSON.stringify(debug.mock.calls);
    for (const fragment of ["fixture-part-one", "fixture-part-two", ...spellings])
      expect(records).not.toContain(fragment);
    expect(records).toContain("[redacted]");
    captured.close();
  });

  it("suppresses rather than cuts a credential larger than the carry bound", async () => {
    const { logger, debug } = fakeLogger();
    const secret = `fixture-${"x".repeat(9000)}-credential-suffix`;
    const stderr = Readable.from([secret.slice(0, 4096), secret.slice(4096)]);
    const captured = captureChildOutput({ stderr, stdout: null } as unknown as ChildProcess, {
      kind: "fixture",
      logger,
      secrets: [secret],
    });
    await new Promise<void>((resolve) => stderr.once("end", resolve));
    expect(captured.tail()).toBe("Output line exceeded the size limit.");
    expect(JSON.stringify(debug.mock.calls)).not.toContain("credential-suffix");
    captured.close();
  });

  it("redacts fallback bindings and does not let them override the record", async () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      createChildProcessLogger().debug("Safe diagnostic", {
        token: "opaque fixture credential",
        nested: { password: "alpha beta gamma" },
        private_key: "fixture-private-credential",
        accessKey: "fixture-access-credential",
        "api-key": "fixture-api-credential",
        clientKey: "fixture-client-credential",
        message: "unsafe binding",
        level: "error",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const record = JSON.parse(String(write.mock.calls[0]?.[0]));
      expect(record.message).toBe("Safe diagnostic");
      expect(record.level).toBe("debug");
      for (const key of ["private_key", "accessKey", "api-key", "clientKey"])
        expect(record[key]).toBe("[Redacted]");
      expect(JSON.stringify(record)).not.toMatch(
        /opaque fixture credential|alpha beta gamma|unsafe binding/,
      );
    } finally {
      write.mockRestore();
      vi.unstubAllEnvs();
    }
  });
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

  it.each([
    ["record count", 1000, "fixture line"],
    ["byte count", 128, "x".repeat(1024)],
  ])("retains the failure behind a blocked sink and full %s queue", async (_limit, count, line) => {
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
      for (let i = 0; i < count; i++) logger.debug(line);
      logger.error?.("Fixture process failed", new Error("phase: prompt; exit: 4"));
      logger.debug("last debug line");
      expect(write).toHaveBeenCalledTimes(1);
      write.mockReturnValue(true);
      sink.emit("drain");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const records = write.mock.calls.map(([output]) => JSON.parse(String(output)));
      const errors = records.filter((record) => record.level === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        message: "Fixture process failed",
        error: { name: "Error", message: "phase: prompt; exit: 4" },
      });
      const summaries = records.filter((record) => record.droppedLines !== undefined);
      expect(summaries).toHaveLength(1);
      const admitted =
        records.filter((record) => record.level === "debug" && record.droppedLines === undefined)
          .length - 1;
      expect(admitted).toBeGreaterThan(0);
      expect(summaries[0].droppedLines).toBe(count - admitted + 1);
      if (_limit === "record count") expect(admitted).toBe(128);
      else expect(admitted).toBeLessThan(128);
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
