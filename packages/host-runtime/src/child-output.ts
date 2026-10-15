import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { redactBindings } from "../../logging/src/redaction.js";
import { serializeError } from "../../logging/src/serialize-error.js";
import {
  createMcpTextNormalizer,
  mcpSecretSpellings,
  redactMcpKnownSecrets,
  redactMcpText,
} from "./mcp-diagnostics.js";

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
  /** Known credentials redacted before detailed diagnostics can leave memory. */
  secrets?: readonly string[];
  logger: ChildOutputLogger;
  /** Capture stdout too; stderr is always captured. */
  captureStdout?: boolean;
  /** Retain a redacted tail for a terminal failure, without enabling debug output. */
  retainFailureDetails?: boolean;
}

export interface CapturedChildOutput {
  /** Redacted debug detail only; empty unless detailed process logging is enabled. */
  tail(): string;
  /** Explicitly requested failure detail; empty for ordinary captures. */
  failureTail(): string;
  /** Content-free facts, safe at every log level. */
  facts(): Record<string, unknown>;
  /** Stop listening and release private output; explicitly retained redacted tails remain. */
  close(): void;
}

const TAIL_LIMIT_BYTES = 64 * 1024;
const PENDING_LIMIT_BYTES = 8 * 1024;
const OVERSIZED_LINE = "Output line exceeded the size limit.";

export function detailedProcessLogsEnabled(): boolean {
  // The Settings switch comes later; explicit environment opt-in is required for now.
  return process.env.ARDUR_DETAILED_PROCESS_LOGS === "1";
}

/** Hold at least the longest spelling before releasing text to the line scanner. */
function knownSecretStream(secrets: readonly string[], emit: (text: string) => void) {
  let pending = "";
  let suppressed = false;
  const normalize = createMcpTextNormalizer();
  return (text: string, final = false) => {
    if (suppressed) return;
    text = normalize(text);
    // Keep the list live: a running transport can acquire additional bridge keys.
    const spellings = mcpSecretSpellings(secrets);
    if (!spellings.length) {
      emit(text);
      return;
    }
    pending += text;
    const longest = Math.max(...spellings.map((spelling) => spelling.length));
    if (longest > PENDING_LIMIT_BYTES || Buffer.byteLength(pending) > TAIL_LIMIT_BYTES) {
      // A bounded carry cannot safely resume after cutting a possible credential.
      // Suppress the rest of this stream rather than disclose its remaining suffix.
      pending = "";
      suppressed = true;
      emit(`${OVERSIZED_LINE}\n`);
      return;
    }
    const result = redactMcpKnownSecrets(pending, spellings, final ? 0 : longest);
    pending = result.pending;
    emit(result.redacted);
  };
}

/** Redact a complete diagnostic with the same wrapped-secret scanner as child output. */
export function redactChildText(text: string, secrets: readonly string[] = []): string {
  const parts: string[] = [];
  knownSecretStream(secrets, (part) => parts.push(part))(text, true);
  return redactMcpText(parts.join(""), secrets);
}

/**
 * One capture point for every child process Ardur starts. Replaces bare
 * `child.stderr.resume()` so no child output is ever discarded unread. Output
 * stays in bounded memory and never reaches a logger by default. Detailed mode
 * redacts known secrets before line framing and releases only debug detail.
 */
export function captureChildOutput(
  child: ChildProcess,
  options: CaptureChildOutputOptions,
): CapturedChildOutput {
  const secrets = options.secrets ?? [];
  const detailed = detailedProcessLogsEnabled();
  const retain = detailed || options.retainFailureDetails === true;
  const lines: string[] = [];
  let bytes = 0;
  let byteCount = 0;
  let lineCount = 0;
  let partialLines = 0;
  let tailSecrets = [...secrets];
  const storeLine = (redacted: string) => {
    const line =
      Buffer.byteLength(redacted, "utf8") > PENDING_LIMIT_BYTES ? OVERSIZED_LINE : redacted;
    if (!line) return "";
    lines.push(line);
    bytes += Buffer.byteLength(line, "utf8") + 1;
    while (bytes > TAIL_LIMIT_BYTES && lines.length > 0) {
      bytes -= Buffer.byteLength(lines.shift()!, "utf8") + 1;
    }
    return line;
  };
  const refreshTail = () => {
    if (
      !retain ||
      (secrets.length === tailSecrets.length &&
        secrets.every((secret, index) => secret === tailSecrets[index]))
    )
      return;
    tailSecrets = [...secrets];
    // Already released text must be scanned again, including wrapped spellings.
    const parts: string[] = [];
    knownSecretStream(secrets, (text) => parts.push(text))(lines.join("\n"), true);
    const redacted = redactMcpText(parts.join(""), secrets);
    lines.length = 0;
    bytes = 0;
    for (const line of redacted.split("\n")) storeLine(line);
  };
  const emit = (stream: "stdout" | "stderr", raw: string) => {
    refreshTail();
    const redacted = retain ? redactMcpText(raw.replace(/\r+$/, ""), secrets) : raw;
    const line = storeLine(redacted);
    if (!line) return;
    if (detailed && detailedProcessLogsEnabled()) {
      options.logger.debug(`${options.kind} ${stream}: ${line}`, {
        kind: options.kind,
        pid: child.pid,
        runId: options.runId,
      });
    }
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
    let ended = false;
    let partial = false;
    const append = (text: string) => {
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const end = newline < 0 ? text.length : newline;
        if (!dropped) {
          pending += text.slice(start, end);
          if (Buffer.byteLength(pending, "utf8") > PENDING_LIMIT_BYTES) {
            pending = "";
            dropped = true;
          }
        }
        if (newline < 0) break;
        emit(name, dropped ? OVERSIZED_LINE : pending);
        pending = "";
        dropped = false;
        start = newline + 1;
      }
    };
    const redactStream = knownSecretStream(secrets, append);
    const consume = (text: string) => {
      for (const character of text) if (character === "\n") lineCount++;
      if (text) {
        if (partial) partialLines--;
        partial = !text.endsWith("\n");
        if (partial) partialLines++;
      }
      if (retain) redactStream(text);
      else append(text);
    };
    const onData = (chunk: Buffer | string) => {
      byteCount += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      // Decode bounded slices even when a custom stream hands us one huge chunk.
      for (let offset = 0; offset < chunk.length; offset += 4096) {
        const part = chunk.slice(offset, offset + 4096);
        consume(typeof part === "string" ? part : decoder.decode(part, { stream: true }));
      }
    };
    const onEnd = () => {
      if (ended) return;
      ended = true;
      consume(decoder.decode());
      if (partial) {
        partialLines--;
        lineCount++;
        partial = false;
      }
      if (retain) redactStream("", true);
      if (pending || dropped) {
        if (dropped) emit(name, OVERSIZED_LINE);
        else emit(name, pending);
        pending = "";
      }
      if (!retain) {
        lines.length = 0;
        bytes = 0;
      }
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    watchers.push({ stream, onData, onEnd });
  };
  watch(child.stderr, "stderr");
  if (options.captureStdout) watch(child.stdout, "stdout");
  return {
    tail: () => {
      if (!detailed || !detailedProcessLogsEnabled()) return "";
      refreshTail();
      return lines.join("\n");
    },
    failureTail: () => {
      if (!options.retainFailureDetails) return "";
      refreshTail();
      return lines.join("\n");
    },
    facts: () => ({
      kind: options.kind,
      processKind: options.kind,
      pid: child.pid,
      runId: options.runId,
      byteCount,
      lineCount: lineCount + partialLines,
      outputProduced: byteCount > 0,
    }),
    close: () => {
      for (const watcher of watchers.splice(0)) {
        watcher.onEnd();
        watcher.stream.off("data", watcher.onData);
        watcher.stream.off("end", watcher.onEnd);
      }
      if (!retain) {
        lines.length = 0;
        bytes = 0;
      }
    },
  };
}

let fallbackLogger: ChildOutputLogger | undefined;

/** A non-blocking handoff: debug is bounded, failure records are never evicted. */
export function createChildProcessLogger(sink: Writable = process.stderr): ChildOutputLogger {
  const queue: string[] = [];
  let queuedBytes = 0;
  let dropped = 0;
  let scheduled = false;
  let blocked = false;
  const schedule = () => {
    if (scheduled || blocked || sink.destroyed) return;
    scheduled = true;
    setImmediate(pump);
  };
  const pump = () => {
    scheduled = false;
    if (sink.destroyed || blocked) return;
    while (queue.length || dropped) {
      const line = queue.shift();
      const output =
        line ??
        `${JSON.stringify({ level: "debug", message: "Child debug lines dropped", droppedLines: dropped })}\n`;
      if (line !== undefined) queuedBytes -= Buffer.byteLength(line);
      else dropped = 0;
      try {
        if (!sink.write(output)) {
          blocked = true;
          sink.once("drain", () => {
            blocked = false;
            schedule();
          });
          return;
        }
      } catch {
        queue.length = 0;
        queuedBytes = 0;
        dropped = 0;
        return;
      }
    }
  };
  const enqueue = (record: Record<string, unknown>) => {
    const line = `${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(line);
    // One error per failure must survive even when debug has filled the queue.
    if (
      record.level !== "error" &&
      (queue.length >= 128 || queuedBytes + size > TAIL_LIMIT_BYTES)
    ) {
      dropped++;
      return;
    }
    queue.push(line);
    queuedBytes += size;
    schedule();
  };
  return {
    debug: (message, bindings) => {
      if (!detailedProcessLogsEnabled() || process.env.LOG_LEVEL?.trim().toLowerCase() !== "debug")
        return;
      enqueue({
        ...redactBindings(bindings ?? {}),
        level: "debug",
        message: redactMcpText(message),
      });
    },
    error: (message, error) => {
      const reason = error === undefined ? undefined : serializeError(error);
      enqueue({ level: "error", message: redactMcpText(message), error: reason });
    },
  };
}

/**
 * Shared fallback for call sites no service logger reaches yet. Content-free
 * failures survive independently of debug opt-in and sink backpressure.
 */
export function childProcessLogger(): ChildOutputLogger {
  fallbackLogger ??= createChildProcessLogger();
  return fallbackLogger;
}
