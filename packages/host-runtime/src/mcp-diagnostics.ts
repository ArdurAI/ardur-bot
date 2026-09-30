import type { McpDiagnostics } from "@ardurbot/contracts";
import { redactSensitiveText } from "../../logging/src/redaction.js";

const sensitiveFlag = /(?:password|passwd|secret|token|key|credential|authorization|cookie)/i;

export function environmentSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([key, value]) =>
    sensitiveFlag.test(key) && value ? [value] : [],
  );
}

/** The private Ardur relay passes its capability as the final positional argument. */
export function mcpConfigSecrets(config: {
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}): string[] {
  return [
    config.args.at(-1) ?? "",
    ...argumentSecrets(config.args),
    ...environmentSecrets(config.env ?? {}),
  ].filter(Boolean);
}
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

function secretSpellings(secret: string): Set<string> {
  return new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
}

export function mcpSecretSpellings(secrets: readonly string[]): string[] {
  const active = secrets.flatMap((secret) => [secret, ...secret.split(/\r?\n/).filter(Boolean)]);
  return [
    ...new Set(active.filter(Boolean).flatMap((secret) => [...secretSpellings(secret)])),
  ].sort((a, b) => b.length - a.length);
}

export function mcpTextContainsSecret(value: string, secret: string): boolean {
  return (
    Boolean(secret) && [...secretSpellings(secret)].some((spelling) => value.includes(spelling))
  );
}

export function redactMcpText(value: string, secrets: readonly string[] = []): string {
  let result = value;
  for (const spelling of mcpSecretSpellings(secrets))
    result = result.split(spelling).join("[redacted]");
  return redactSensitiveText(result)
    .replaceAll("[Redacted]", "[redacted]")
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
