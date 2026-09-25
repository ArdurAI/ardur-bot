import type { McpDiagnostics } from "@ardurbot/contracts";

const sensitiveFlag = /(?:password|passwd|secret|token|api[-_]?key|credential|authorization)/i;
export function argumentSecrets(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-") || !sensitiveFlag.test(arg.split("=")[0]!)) continue;
    const equal = arg.indexOf("=");
    if (equal >= 0) values.push(arg.slice(equal + 1));
    else if (args[i + 1]) values.push(args[++i]!);
  }
  return values.filter(Boolean);
}

export function redactMcpText(value: string, secrets: readonly string[] = []): string {
  let result = value;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const spelling of new Set([
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
    ]))
      result = result.split(spelling).join("[redacted]");
  }
  return result
    .replace(/(Bearer\s+)[^\s,"'}]+/gi, "$1[redacted]")
    .replace(
      /((?:password|passwd|secret|token|api[-_]?key|credential|authorization)["']?\s*[:=]\s*)[^\s,;}]+/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g"), "");
}

export function redactMcpArguments(
  args: readonly string[],
  secrets: readonly string[] = [],
): string[] {
  return args.map((arg) => redactMcpText(arg, [...secrets, ...argumentSecrets(args)]));
}
export function redactMcpValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 64) return "[redacted]";
  if (typeof value === "string") return redactMcpText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactMcpValue(entry, secrets, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactMcpValue(entry, secrets, depth + 1)]),
    );
  return value;
}

/** Keeps complete lines only, with redaction before storage and a second byte bound. */
export class McpLogBuffer {
  private lines: string[] = [];
  private pending = "";
  private dropping = false;
  private readonly decoder = new TextDecoder();
  private state: McpDiagnostics["status"] = "stopped";
  private lastError: string | null = null;
  private updatedAt: string | null = null;
  private secrets: string[];
  constructor(
    secrets: readonly string[] = [],
    private readonly changed?: (value: McpDiagnostics) => void,
  ) {
    this.secrets = [...secrets];
  }
  setSecrets(secrets: readonly string[]) {
    this.secrets = [...secrets];
  }
  touch() {
    this.updatedAt = new Date().toISOString();
    this.changed?.(this.snapshot());
  }
  private line(value: string) {
    const line = redactMcpText(value, this.secrets).slice(0, 2048);
    this.lines.push(line);
    while (
      this.lines.length > 200 ||
      this.lines.reduce((n, entry) => n + Buffer.byteLength(JSON.stringify(entry)), 0) > 96_000
    )
      this.lines.shift();
    this.updatedAt = new Date().toISOString();
    this.changed?.(this.snapshot());
  }
  append(chunk: string | Uint8Array) {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    for (const part of text.split(/(?<=\n)/)) {
      if (!this.dropping) this.pending += part;
      if (this.pending.length > 8192) {
        this.pending = "";
        this.dropping = true;
      }
      if (part.endsWith("\n")) {
        this.line(
          this.dropping
            ? "Log line exceeded the size limit."
            : this.pending.replace(/[\r\n]+$/, ""),
        );
        this.pending = "";
        this.dropping = false;
      }
    }
  }
  status(status: McpDiagnostics["status"], error?: unknown) {
    this.state = status;
    if (status === "running") this.lastError = null;
    if (error !== undefined) {
      this.lastError =
        redactMcpText(error instanceof Error ? error.message : String(error), this.secrets)
          .split(/\r?\n/)
          .filter(Boolean)
          .at(-1)
          ?.slice(0, 2048) ?? "Server failed.";
      this.line(this.lastError);
    }
    this.updatedAt = new Date().toISOString();
    this.changed?.(this.snapshot());
  }
  finish() {
    this.append(this.decoder.decode());
    if (this.pending || this.dropping) this.append("\n");
    if (this.state !== "error") this.status("stopped");
  }
  snapshot(): McpDiagnostics {
    return {
      status: this.state,
      lastError: this.lastError,
      lines: [...this.lines],
      updatedAt: this.updatedAt,
    };
  }
}
