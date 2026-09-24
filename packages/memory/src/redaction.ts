import { createStreamingRedactor } from "@ardurbot/core";
import { redactSensitiveText } from "@ardurbot/logging";

export class MemoryRedactionError extends Error {
  constructor() {
    super("Remove credentials from this memory before saving.");
  }
}
/** Detection reduces risk; it cannot recognise arbitrary secrets. Never log rejected input. */
export function assertMemorySafe(value: unknown, knownSecrets: readonly string[] = []): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const stream = createStreamingRedactor([...knownSecrets]);
  const redacted = stream.push(text) + stream.finish();
  if (
    redacted !== text ||
    redactSensitiveText(text) !== text ||
    /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|:\/\/[^\s/:]+:[^\s/@]+@/u.test(
      text,
    )
  ) {
    throw new MemoryRedactionError();
  }
}
export function assertMemoryPath(path: string): void {
  if (
    !path ||
    path.length > 500 ||
    path.startsWith("/") ||
    /[\\:]/u.test(path) ||
    Array.from(path).some((character) => character.charCodeAt(0) < 32) ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error("Choose a relative Markdown filename without parent directories.");
  }
  assertMemorySafe(path);
}
