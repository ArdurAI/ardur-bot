import type { ChildProcess } from "node:child_process";
import { redactMcpText } from "./mcp-diagnostics.js";

/**
 * The slice of a service logger the capture helper needs. The logging package's
 * Logger satisfies this shape, so a composition root can inject the real one.
 */
export interface ChildOutputLogger {
  debug(message: string, bindings?: Record<string, unknown>): void;
  error?(message: string, error?: unknown): void;
}

export interface CaptureChildOutputOptions {
  /** Short process tag, e.g. "hermes" or "host-probe". */
  kind: string;
  runId?: string;
  /** Run secrets replaced with [redacted] before anything is stored or logged. */
  secrets?: readonly string[];
  logger: ChildOutputLogger;
  /** Capture stdout too; stderr is always captured. */
  captureStdout?: boolean;
}

export interface CapturedChildOutput {
  /** The last ~64 KB of redacted output, for failure reports. */
  tail(): string;
  /** Stop listening; buffered output stays available through tail(). */
  close(): void;
}

const TAIL_LIMIT_BYTES = 64 * 1024;
const PENDING_LIMIT_BYTES = 8 * 1024;

/**
 * One capture point for every child process Ardur starts. Replaces bare
 * `child.stderr.resume()` so no child output is ever discarded unread: each
 * line is redacted with the run's secrets and the shared text redaction,
 * kept in a bounded ring buffer, and streamed to the logger at debug level
 * tagged with kind, pid and run id. Nothing leaves this helper unredacted.
 */
export function captureChildOutput(
  child: ChildProcess,
  options: CaptureChildOutputOptions,
): CapturedChildOutput {
  const secrets = options.secrets ?? [];
  const lines: string[] = [];
  let bytes = 0;
  const emit = (stream: "stdout" | "stderr", raw: string) => {
    const line = redactMcpText(raw.replace(/\r+$/, ""), secrets);
    if (!line) return;
    lines.push(line);
    bytes += Buffer.byteLength(line, "utf8") + 1;
    while (bytes > TAIL_LIMIT_BYTES && lines.length > 1) {
      bytes -= Buffer.byteLength(lines.shift()!, "utf8") + 1;
    }
    options.logger.debug(`${options.kind} ${stream}: ${line}`, {
      kind: options.kind,
      pid: child.pid,
      runId: options.runId,
    });
  };
  const watchers: {
    stream: NodeJS.ReadableStream;
    onData: (chunk: Buffer | string) => void;
    onEnd: () => void;
  }[] = [];
  const watch = (stream: NodeJS.ReadableStream | null, name: "stdout" | "stderr") => {
    if (!stream) return;
    const decoder = new TextDecoder();
    let pending = "";
    let dropped = false;
    const onData = (chunk: Buffer | string) => {
      pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (dropped) {
          emit(name, "Output line exceeded the size limit.");
          dropped = false;
        } else {
          emit(name, line);
        }
        newline = pending.indexOf("\n");
      }
      if (pending.length > PENDING_LIMIT_BYTES) {
        pending = "";
        dropped = true;
      }
    };
    const onEnd = () => {
      pending += decoder.decode();
      if (pending) {
        if (dropped) emit(name, "Output line exceeded the size limit.");
        else emit(name, pending);
        pending = "";
      }
      decoder.decode();
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    watchers.push({ stream, onData, onEnd });
  };
  watch(child.stderr, "stderr");
  if (options.captureStdout) watch(child.stdout, "stdout");
  return {
    tail: () => lines.join("\n"),
    close: () => {
      for (const watcher of watchers.splice(0)) {
        watcher.stream.off("data", watcher.onData);
        watcher.stream.off("end", watcher.onEnd);
      }
    },
  };
}

let fallbackLogger: ChildOutputLogger | undefined;

/**
 * Shared fallback for call sites no service logger reaches yet. Debug lines
 * stream only when LOG_LEVEL=debug, so the tail on failure carries the detail
 * even where nothing has injected the real logger.
 */
export function childProcessLogger(): ChildOutputLogger {
  fallbackLogger ??= {
    debug: (message, bindings) => {
      if (process.env.LOG_LEVEL?.trim().toLowerCase() !== "debug") return;
      process.stderr.write(`${JSON.stringify({ level: "debug", message, ...bindings })}\n`);
    },
    error: (message, error) => {
      const reason =
        error instanceof Error
          ? { name: error.name, message: error.message, cause: error.cause }
          : error;
      process.stderr.write(`${JSON.stringify({ level: "error", message, error: reason })}\n`);
    },
  };
  return fallbackLogger;
}
