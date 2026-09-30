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

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// Quoted values must be consumed whole, before the unquoted assignment rule.
// Empty, elided and template values are documentation placeholders, not secrets.
const TEXT_REDACTIONS: readonly [RegExp, string][] = [
  [
    /(["'][^"'\r\n]*(?:password|passwd|secret|token|key|credential|authorization|cookie|email)[^"'\r\n]*["']\s*:\s*)"(?!(?:|\[Redacted\]|[.*…]+|<[^"<>]+>|\$\{[^"{}]+\}|\{\{[^"{}]+\}\})")(?:\\.|[^"\\])*"/gi,
    `$1"${REDACTED}"`,
  ],
  [
    /((?:["']?[A-Za-z0-9_-]*(?:password|passwd|secret|token|key|credential|authorization|cookie)[A-Za-z0-9_-]*["']?)\s*[:=]\s*)'(?!(?:|\[Redacted\]|[.*…]+|<[^'<>]+>)')(?:\\.|[^'\\])*'/gi,
    `$1'${REDACTED}'`,
  ],
  [
    /\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|key|credential|authorization|cookie)[A-Za-z0-9_-]*)\s*=\s*"(?:\\.|[^"\\])*"/gi,
    `$1="${REDACTED}"`,
  ],
  [/\b(Bearer\s+)[^\s"',;&}]+/gi, `$1${REDACTED}`],
  [
    /(?<![A-Za-z0-9_"'])\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|key|credential|authorization|cookie)[A-Za-z0-9_-]*)\s*[:=]\s*(?!["'])[^\s,;}]+/gi,
    `$1=${REDACTED}`,
  ],
  [/\bgh[pousr]_[A-Za-z0-9_]+\b/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?:=)?(?![A-Za-z0-9/+=])/g, REDACTED],
  [/\b(?:sk-|xai-)[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED],
  [/\b(?:ak_|ck_)[A-Za-z0-9]+\b/g, REDACTED],
  [/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
];

export function redactSensitiveText(text: string): string {
  let result = text.replace(EMAIL, REDACTED);
  for (const [pattern, replacement] of TEXT_REDACTIONS)
    result = result.replace(pattern, replacement);
  return result;
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return REDACT_KEYS.has(normalized) || SECRET_KEY.test(normalized);
}
