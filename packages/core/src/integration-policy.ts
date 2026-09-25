import type { IntegrationDescriptor, SpaceToolPolicies } from "@ardurbot/contracts";

export type IntegrationApproval = "ask-first" | "allow" | "disabled";

export function effectiveTools(
  vendorTools: readonly string[],
  spaceGrant: readonly string[],
  botAllowlist: readonly string[],
): string[] {
  const space = new Set(spaceGrant);
  const bot = new Set(botAllowlist);
  return [...new Set(vendorTools)].filter((id) => space.has(id) && bot.has(id));
}

const WRITE =
  /comment|post|create|merge|deploy|delete|update|transition|trigger|cancel|write|remove|send|execute|mutat|publish|archive|approve|assign|edit|patch|upload|push|commit|revoke|grant/i;

/** Classification alone never confers approval; an explicit read policy is still required. */
export function integrationToolKind(id: string, description: string): "read" | "write" {
  return !WRITE.test(`${id} ${description}`) && /get|list|search|find|read|fetch/i.test(id)
    ? "read"
    : "write";
}

export function approvalFor(
  descriptor: Pick<IntegrationDescriptor, "available" | "toolPolicies">,
  toolId: string,
  args: Record<string, unknown>,
  description = "",
  spaceToolPolicies: SpaceToolPolicies = {},
): IntegrationApproval {
  if (!descriptor.available) return "disabled";
  const policy = descriptor.toolPolicies[toolId];
  if (policy?.approval === "disabled") return "disabled";
  if (WRITE.test(`${toolId} ${description}`)) return "ask-first";
  // Multiplexed tools may select a write through their arguments.
  if (
    Object.entries(args).some(
      ([key, value]) =>
        /^(action|operation|method|command)$/i.test(key) &&
        (typeof value !== "string" || !/^(get|list|search|find|read|fetch)$/i.test(value)),
    )
  )
    return "ask-first";
  if (policy?.approval === "allow" && policy.risk === "reviewed-read") return "allow";
  return integrationToolKind(toolId, description) === "read" &&
    Object.hasOwn(spaceToolPolicies, toolId) &&
    spaceToolPolicies[toolId] === "allow"
    ? "allow"
    : "ask-first";
}
