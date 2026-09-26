import { redactSensitiveText } from "@ardurbot/logging";

export class MemoryRedactionError extends Error {
  constructor() {
    super("Remove credentials from this memory before saving.");
  }
}
const CREDENTIAL =
  /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|:\/\/[^\s/:]+:[^\s/@]+@/u;
/** Detection reduces risk; it cannot recognise arbitrary secrets. Never log rejected input. */
export function assertMemorySafe(value: unknown, knownSecrets: readonly string[] = []): void {
  // Test each string as written. In JSON text an escape joins its neighbour, so a line
  // starting "@app.get" reads as the address "n@app.get" after "\n".
  const texts: string[] = [];
  // Strings are replaced in this outline, which still exposes secret-named fields.
  const outline =
    typeof value === "string"
      ? ""
      : (JSON.stringify(value, (key, nested: unknown) => {
          texts.push(key);
          if (typeof nested !== "string") return nested;
          texts.push(nested);
          return "value";
        }) ?? "");
  if (typeof value === "string") texts.push(value);
  if (
    redactSensitiveText(outline) !== outline ||
    texts.some(
      (text) =>
        knownSecrets.some((secret) => secret && text.includes(secret)) ||
        redactSensitiveText(text) !== text ||
        CREDENTIAL.test(text),
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
