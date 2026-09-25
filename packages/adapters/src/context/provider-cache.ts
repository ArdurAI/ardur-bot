/** The SDK's payload hook lets the protocol adapter mark exactly the stable system block. */
export function markStablePrefix(payload: unknown, stablePrefix: string): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const request = payload as Record<string, unknown>;
  const system = request.system;
  const blocks =
    typeof system === "string"
      ? [{ type: "text", text: system }]
      : Array.isArray(system)
        ? system
        : [];
  if (!blocks.length || blocks.map((block) => block.text ?? "").join("\n\n") !== stablePrefix)
    return payload;
  return {
    ...request,
    system: blocks.map((block, index) => ({
      ...block,
      ...(index === blocks.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    })),
  };
}
