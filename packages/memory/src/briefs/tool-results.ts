import { redactSecrets } from "@ardurbot/core";

/** Retain bounded text for a deferred rewrite; omit image bytes and redact before persistence. */
export function appendBriefToolResult(
  previous: string,
  name: string,
  result: unknown,
  secrets: string[],
): string {
  let text: string;
  try {
    text =
      JSON.stringify(result, (_key, value) => {
        if (value && typeof value === "object" && ["image", "audio"].includes(value.type))
          return undefined;
        if (typeof value === "string") return redactSecrets(value, secrets).slice(0, 1200);
        if (Array.isArray(value)) return value.slice(0, 5);
        return value;
      }) ?? "";
  } catch {
    return previous;
  }
  const entry = `${name}: ${redactSecrets(text, secrets).slice(0, 1800)}`;
  return [previous, entry].filter(Boolean).join("\n").slice(-6000);
}
