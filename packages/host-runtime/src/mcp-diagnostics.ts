import type { McpDiagnostics } from "@ardurbot/contracts";
import { redactSensitiveText } from "../../logging/src/redaction.js";

const sensitiveFlag = /(?:password|passwd|secret|token|key|credential|authorization|cookie)/i;

// Preserve physical line framing; discard invisible token separators before matching.
const invisibleSeparator =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Controls are the separators being removed.
  /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\p{Default_Ignorable_Code_Point}/u;

/** Constant-space terminal parser, including escapes split across stream chunks. */
export function createMcpTextNormalizer() {
  let state: "text" | "escape" | "csi" | "string" | "string-escape" = "text";
  let osc = false;
  return (text: string): string => {
    if (state === "text" && !invisibleSeparator.test(text)) return text;
    const parts: string[] = [];
    for (const character of text) {
      if (state === "string" || state === "string-escape") {
        if (
          character === "\u009c" ||
          (osc && character === "\x07") ||
          (state === "string-escape" && character === "\\")
        )
          state = "text";
        else state = character === "\x1b" ? "string-escape" : "string";
      } else if (character === "\x1b") state = "escape";
      else if (character === "\u009b") state = "csi";
      else if (character === "\u009d") {
        state = "string";
        osc = true;
      } else if (state === "escape") {
        if (character === "[") state = "csi";
        else if (character === "]" || /[PX^_]/.test(character)) {
          state = "string";
          osc = character === "]";
        } else if (character >= "0" && character <= "~") state = "text";
      } else if (state === "csi") {
        if (character >= "@" && character <= "~") state = "text";
      } else if (!invisibleSeparator.test(character)) parts.push(character);
    }
    // Unterminated escapes stay suppressed, never buffered or released as text.
    return parts.join("");
  };
}

function normalizeMcpText(text: string): string {
  return createMcpTextNormalizer()(text);
}

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

const knownSecretSeparator = /[\p{White_Space}\p{M}]/u;

function foldKnownSecretText(text: string) {
  const offsets: number[] = [];
  const characters: string[] = [];
  let index = 0;
  for (const character of text) {
    if (!knownSecretSeparator.test(character)) {
      characters.push(character);
      // Matches use UTF-16 offsets, including both units of supplementary characters.
      for (let unit = 0; unit < character.length; unit++) offsets.push(index + unit);
    }
    index += character.length;
  }
  return { folded: characters.join(""), offsets };
}

export function mcpSecretSpellings(secrets: readonly string[]): string[] {
  const active = secrets.flatMap((secret) => [secret, ...secret.split(/\r?\n/).filter(Boolean)]);
  return [
    ...new Set(
      active
        .filter(Boolean)
        .flatMap((secret) =>
          [...secretSpellings(secret)].map(
            (spelling) => foldKnownSecretText(normalizeMcpText(spelling)).folded,
          ),
        )
        .filter(Boolean),
    ),
  ].sort((a, b) => b.length - a.length);
}

export function mcpTextContainsSecret(value: string, secret: string): boolean {
  const normalized = foldKnownSecretText(normalizeMcpText(value)).folded;
  return (
    Boolean(secret) &&
    mcpSecretSpellings([secret]).some((spelling) => normalized.includes(spelling))
  );
}

/** Redact normalized text, holding a folded suffix for a possible streaming match. */
export function redactMcpKnownSecrets(text: string, spellings: readonly string[], carry = 0) {
  if (!spellings.length) return { redacted: text, pending: "" };
  // Match even across word boundaries: false redaction is cheaper than a leaked key.
  // Folding is linear and only affects matching; unrelated text retains its separators.
  const { folded, offsets } = foldKnownSecretText(text);
  const cutoff = Math.max(0, folded.length - carry);
  const matches = spellings.map((spelling) => ({ spelling, index: folded.indexOf(spelling) }));
  let copied = 0;
  const parts: string[] = [];
  while (true) {
    let first = -1;
    let length = 0;
    for (const match of matches) {
      if (
        match.index >= 0 &&
        (first < 0 ||
          match.index < first ||
          (match.index === first && match.spelling.length > length))
      ) {
        first = match.index;
        length = match.spelling.length;
      }
    }
    if (first < 0 || first >= cutoff) break;
    const start = offsets[first]!;
    const end = offsets[first + length - 1]! + 1;
    // Keep physical line framing, but replace every other interleaved character.
    parts.push(
      text.slice(copied, start),
      text.slice(start, end).replace(/[^\r\n]+/g, "[redacted]"),
    );
    copied = end;
    const searched = first + length;
    // Cache misses and advance each spelling's cursor instead of rescanning the suffix.
    for (const match of matches)
      if (match.index >= 0 && match.index < searched)
        match.index = folded.indexOf(match.spelling, searched);
  }
  const end = Math.max(copied, carry === 0 ? text.length : (offsets[cutoff] ?? text.length));
  parts.push(text.slice(copied, end));
  return { redacted: parts.join(""), pending: text.slice(end) };
}

export function redactMcpText(value: string, secrets: readonly string[] = []): string {
  const { redacted: result } = redactMcpKnownSecrets(
    normalizeMcpText(value),
    mcpSecretSpellings(secrets),
  );
  return redactSensitiveText(result).replaceAll("[Redacted]", "[redacted]");
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
