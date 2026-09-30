import type { ChildProcessWithoutNullStreams } from "node:child_process";

type JsonObject = Record<string, unknown>;

export class AcpClientError extends Error {
  /**
   * The agent's own error text, kept only so the runtime can classify the failure's
   * cause. It is never stored or shown; the recorded failure names the category.
   */
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "AcpClientError";
  }
}

/** The matchable text of a JSON-RPC error: its message and any nested message. */
function acpErrorDetail(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const parts: string[] = [];
  if ("message" in error && typeof error.message === "string") parts.push(error.message);
  const data = "data" in error ? error.data : undefined;
  if (typeof data === "string") parts.push(data);
  else if (
    data &&
    typeof data === "object" &&
    "message" in data &&
    typeof data.message === "string"
  )
    parts.push(data.message);
  return parts.length ? parts.join("\n") : undefined;
}

export interface AcpClientOptions {
  maxLineBytes?: number;
  timeoutMs?: number;
  onUpdate?: (sessionId: string, update: JsonObject) => void;
  onPermissionAttempt?: () => void;
}

/** A deliberately small ACP v1 client. stdout belongs exclusively to JSON-RPC. */
export class AcpClient {
  private readonly pending = new Map<
    number,
    { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private closed: Error | undefined;
  private readonly maxLineBytes: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: AcpClientOptions = {},
  ) {
    this.maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stdout.on("end", () => this.fail("ACP closed before the turn completed."));
    child.stdin.on("error", () => this.fail("ACP input closed."));
    child.on("error", () => this.fail("ACP process failed."));
    child.on("close", () => this.fail("ACP process exited before the turn completed."));
  }

  private send(value: JsonObject) {
    if (this.closed) throw this.closed;
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      this.fail("ACP input closed.");
      throw this.closed;
    }
    const line = `${JSON.stringify(value)}\n`;
    this.child.stdin.write(line);
  }

  private fail(message: string) {
    if (this.closed) return;
    this.closed = new AcpClientError(message);
    this.buffer = Buffer.alloc(0);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(this.closed);
    }
    this.pending.clear();
  }

  private receive(chunk: Buffer) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline = this.buffer.indexOf(10);
    while (newline >= 0) {
      if (newline > this.maxLineBytes) {
        this.fail("ACP line exceeded its size limit.");
        return;
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length) {
        let value: unknown;
        try {
          value = JSON.parse(line.toString("utf8"));
        } catch {
          this.fail("ACP sent malformed JSON.");
          return;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          this.fail("ACP sent an invalid message.");
          return;
        }
        try {
          this.dispatch(value as JsonObject);
        } catch {
          // A callback must never throw from the child stdout listener.
          this.fail("ACP update handler failed.");
          return;
        }
        if (this.closed) return;
      }
      newline = this.buffer.indexOf(10);
    }
    if (this.buffer.length > this.maxLineBytes) this.fail("ACP line exceeded its size limit.");
  }

  private dispatch(message: JsonObject) {
    if (message.jsonrpc !== "2.0") {
      this.fail("ACP sent an invalid protocol version.");
      return;
    }
    if (typeof message.method === "string") {
      if (message.method === "session/update") {
        const params = message.params;
        if (
          params &&
          typeof params === "object" &&
          !Array.isArray(params) &&
          typeof (params as JsonObject).sessionId === "string" &&
          (params as JsonObject).update &&
          typeof (params as JsonObject).update === "object" &&
          !Array.isArray((params as JsonObject).update)
        )
          this.options.onUpdate?.(
            (params as JsonObject).sessionId as string,
            (params as JsonObject).update as JsonObject,
          );
        else this.fail("ACP sent an invalid session update.");
        return;
      }
      if (message.id === undefined || message.id === null) return;
      if (message.method === "session/request_permission") {
        this.options.onPermissionAttempt?.();
        const params = message.params as JsonObject | undefined;
        const options = Array.isArray(params?.options) ? params.options : [];
        const reject = options.find(
          (option): option is JsonObject =>
            !!option && typeof option === "object" && option.kind === "reject_once",
        );
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            outcome:
              typeof reject?.optionId === "string"
                ? { outcome: "selected", optionId: reject.optionId }
                : { outcome: "cancelled" },
          },
        });
        return;
      }
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Client capability unavailable." },
      });
      return;
    }
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
      this.fail("ACP sent an invalid response ID.");
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) {
      this.fail("ACP sent an unexpected response.");
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined)
      entry.reject(new AcpClientError("ACP request failed.", acpErrorDetail(message.error)));
    else if (message.result && typeof message.result === "object" && !Array.isArray(message.result))
      entry.resolve(message.result as JsonObject);
    else entry.reject(new AcpClientError("ACP sent an invalid response."));
  }

  request(method: string, params: JsonObject, timeoutMs = this.timeoutMs): Promise<JsonObject> {
    if (this.closed) return Promise.reject(this.closed);
    if (!Number.isSafeInteger(this.nextId))
      return Promise.reject(new AcpClientError("ACP request IDs were exhausted."));
    const id = this.nextId++;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpClientError("ACP request timed out."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: JsonObject) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  close() {
    this.fail("ACP connection closed.");
  }
}
