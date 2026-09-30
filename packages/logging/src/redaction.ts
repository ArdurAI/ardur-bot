const REDACTED = "[Redacted]";
const REDACT_KEYS = new Set([
  "email",
  "prompt",
  "message",
  "messages",
  "body",
  "query",
  "rawheaders",
  "headers",
  "passwd",
  "api_key",
]);
const SECRET_KEY = /password|secret|token|authorization|cookie|credential|apikey/;

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      name: redactSensitiveText(value.name || "Error"),
      message: redactSensitiveText(value.message),
    };
    if (typeof value.stack === "string" && value.stack.length > 0) {
      output.stack = redactSensitiveText(value.stack);
    }
    if (value.cause !== undefined) {
      output.cause =
        typeof value.cause === "string"
          ? redactSensitiveText(value.cause)
          : redactValue(value.cause, seen);
    }
    return output;
  }
  if (value instanceof Date) return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = shouldRedactKey(key) ? REDACTED : redactValue(nested, seen);
  }
  return output;
}

export function redactBindings(bindings: Record<string, unknown>): Record<string, unknown> {
  return redactValue(bindings) as Record<string, unknown>;
}

// Start only at a local-part boundary, never at every character of a long token.
const EMAIL = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const CREDENTIAL_URL = /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
const ASSIGNMENT_KEY =
  /(["'])([^"'\r\n]*)\1\s*[:=]\s*|(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)["']?\s*[:=]\s*/g;
const TEXT_SECRET_KEY =
  /password|passwd|secret|token|credential|authorization|cookie|(?:api|private|access|client)[_\s-]?key/i;
// References, counts and presence flags describe credentials without containing them.
const TEXT_METADATA_KEY = /(?:secret|token|credential)(?:id|count|absent|present)$/i;
// Empty, elided and template values are documentation placeholders, not secrets.
const PLACEHOLDER = /^(?:|\[Redacted\]|[.*…]+|<[^<>]+>|\$\{[^{}]+\}|\{\{[^{}]+\}\})$/i;

function quotedEnd(text: string, start: number): number {
  const quote = text[start];
  let end = start + 1;
  // Consume a value once, including escapes; an unterminated value is secret too.
  while (end < text.length && text[end] !== quote) {
    end += text[end] === "\\" ? 2 : 1;
  }
  return Math.min(end, text.length);
}

function containerEnd(text: string, start: number): number {
  const closing = [text[start] === "{" ? "}" : "]"];
  let quote = "";
  for (let end = start + 1; end < text.length; end++) {
    const character = text[end]!;
    if (quote) {
      if (character === "\\") end++;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{" || character === "[") {
      closing.push(character === "{" ? "}" : "]");
    } else if (character === closing.at(-1)) {
      closing.pop();
      if (closing.length === 0) return end + 1;
    }
  }
  return text.length;
}

function redactAssignments(text: string): string {
  const keys = new RegExp(ASSIGNMENT_KEY);
  const parts: string[] = [];
  let copied = 0;
  for (let match = keys.exec(text); match; match = keys.exec(text)) {
    const key = match[2] ?? match[3]!;
    if (TEXT_METADATA_KEY.test(key.replace(/[^a-z0-9]/gi, ""))) continue;
    if (
      !TEXT_SECRET_KEY.test(key) &&
      !(match[2] !== undefined ? /email/i.test(key) : /^key$/i.test(key))
    )
      continue;
    const start = keys.lastIndex;
    const quote = text[start];
    let end = start;
    let replacement = REDACTED;
    if (quote === '"' || quote === "'") {
      end = quotedEnd(text, start);
      const closed = text[end] === quote;
      const value = text.slice(start + 1, end);
      if (closed) end++;
      keys.lastIndex = end;
      if (closed && PLACEHOLDER.test(value)) continue;
      replacement = `${quote}${REDACTED}${closed ? quote : ""}`;
    } else {
      if (quote === "{" || quote === "[") {
        end = containerEnd(text, start);
      } else {
        while (end < text.length && !/[\s"',;}&\]]/.test(text[end]!)) end++;
        // An auth value includes its scheme and credential, not just the first word.
        if (end > start && /authorization/i.test(key)) {
          while (text[end] === " " || text[end] === "\t") end++;
          if (text[end] === '"' || text[end] === "'") {
            const credentialQuote = text[end];
            end = quotedEnd(text, end);
            if (text[end] === credentialQuote) end++;
          } else {
            while (end < text.length && !/[\s"',;}&\]]/.test(text[end]!)) end++;
          }
        }
      }
      keys.lastIndex = end;
      if (end === start) continue;
      // Replacing a JSON scalar or container must leave valid JSON, too.
      if (match[2] !== undefined) replacement = `"${REDACTED}"`;
    }
    parts.push(text.slice(copied, start), replacement);
    copied = end;
  }
  return copied === 0 ? text : [...parts, text.slice(copied)].join("");
}

// Each unbounded run has a non-overlapping start or a delimiter outside its
// alphabet. In particular, URL user names exclude ':' so password scans cannot
// restart at every colon, and JWT segments cannot restart inside another segment.
const TEXT_REDACTIONS: readonly [RegExp, string][] = [
  [/\b(Bearer\s+)[^\s"',;&}]+/gi, `$1${REDACTED}`],
  [/\bgh[pousr]_[A-Za-z0-9_]+\b/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\b(?:sk-|xai-)[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  [/\b(?:ak_|ck_)[A-Za-z0-9]+\b/g, REDACTED],
];
const AWS_SECRET = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?:=)?(?![A-Za-z0-9/+=])/g;
const JWT = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

export function redactSensitiveText(text: string): string {
  // Hide URL credentials before their password/host suffix can look like an email.
  let result = text.includes("@")
    ? text.replace(CREDENTIAL_URL, `$1${REDACTED}@`).replace(EMAIL, REDACTED)
    : text;
  result = redactAssignments(result);
  for (const [pattern, replacement] of TEXT_REDACTIONS)
    result = result.replace(pattern, replacement);
  // SHA-1 commit IDs share the AWS key length but are public provenance, not credentials.
  result = result.replace(AWS_SECRET, (value: string) =>
    /^[a-f0-9]{40}$/i.test(value) ? value : REDACTED,
  );
  // Ordinary dotted text must not invoke the JWT callback for every three words.
  return result.includes("eyJ") && result.includes(".")
    ? result.replace(JWT, (token: string, header: string) =>
        /\beyJ[A-Za-z0-9_-]+/.test(header) ? REDACTED : token,
      )
    : result;
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return REDACT_KEYS.has(normalized) || SECRET_KEY.test(normalized);
}
