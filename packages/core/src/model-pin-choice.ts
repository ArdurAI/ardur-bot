/** Include the connection so same-named models on different endpoints remain distinct. */
export function modelPinOptionKey(provider: string, modelId: string, credentialId?: string | null) {
  return credentialId
    ? JSON.stringify([provider, modelId, credentialId])
    : `${provider}::${modelId}`;
}

export function parseModelPinOptionKey(
  key: string,
): { provider: string; modelId: string; credentialId?: string } | null {
  if (key.startsWith("[")) {
    try {
      const value: unknown = JSON.parse(key);
      if (
        Array.isArray(value) &&
        value.length === 3 &&
        value.every((item) => typeof item === "string" && item.length > 0)
      ) {
        return { provider: value[0], modelId: value[1], credentialId: value[2] };
      }
    } catch {
      /* Retain the legacy pair format below. */
    }
    return null;
  }
  const separator = key.indexOf("::");
  return separator > 0
    ? { provider: key.slice(0, separator), modelId: key.slice(separator + 2) }
    : null;
}

import type { ThinkingLevel } from "@ardurbot/contracts";

/** Compatibility for an inherited space choice with no explicit effort to validate. */
export function spaceDefaultEffort(
  reasoning: boolean | undefined,
  levels?: readonly ThinkingLevel[],
): ThinkingLevel {
  if (reasoning === false) return "off";
  const order: ThinkingLevel[] = ["medium", "high", "xhigh", "max", "low", "minimal", "off"];
  return order.find((level) => !levels || levels.includes(level)) ?? "off";
}

/** The inherited local pin stores the resolved reasoning state, not the display effort. */
export function inheritedOllamaEffort(
  thinkingLevel: ThinkingLevel | null | undefined,
  reasoning: boolean | undefined,
): ThinkingLevel | "none" | null {
  if (thinkingLevel === "off") return reasoning === false ? null : "none";
  return thinkingLevel ?? (reasoning ? "medium" : null);
}
