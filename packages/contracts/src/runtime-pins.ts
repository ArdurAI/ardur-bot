import * as z from "zod";
import type { ThinkingLevel } from "./domain.js";
import { Id } from "./ids.js";

export const RuntimeKindSchema = z.enum([
  "pi",
  "claude-code",
  "codex-app-server",
  "antigravity",
  "hermes",
]);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;
/** The pin may store no-thinking as null or "none"; runtime models use "off". */
export const normalizedThinkingLevel = (value: string | null | undefined): string =>
  value == null || value === "none" ? "off" : value;
export const runtimeNames: Record<RuntimeKind, string> = {
  pi: "Ardur",
  "claude-code": "Claude Code",
  "codex-app-server": "Codex",
  antigravity: "Antigravity",
  hermes: "Hermes",
};
export const runtimeLabels: Record<RuntimeKind, string> = {
  pi: "Ardur (built-in)",
  "claude-code": "Claude Code (your claude sign-in)",
  "codex-app-server": "Codex (your ChatGPT sign-in)",
  antigravity: "Antigravity",
  hermes: "Hermes",
};
export const nativeRuntimeProviders = {
  "claude-code": "anthropic",
  "codex-app-server": "openai-codex",
  antigravity: "antigravity",
} as const;
export const nativeRuntimeHealthKeys = {
  "claude-code": "claude",
  "codex-app-server": "codex",
  antigravity: "antigravity",
  hermes: "hermes",
} as const;

export const HermesRuntimeConfigSchema = z.strictObject({
  version: z.literal(1),
  maxProviderRequests: z.number().int().min(1).max(64),
  timeoutMs: z.number().int().min(1_000).max(600_000).multipleOf(1_000),
});
export type HermesRuntimeConfig = z.infer<typeof HermesRuntimeConfigSchema>;
export const HERMES_RUNTIME_DEFAULTS: HermesRuntimeConfig = {
  version: 1,
  maxProviderRequests: 16,
  timeoutMs: 180_000,
};
export const HERMES_HOST_MAX_OUTPUT_TOKENS = 65_536;

export const RuntimeAvailabilitySchema = z.object({
  runtimeKind: RuntimeKindSchema,
  available: z.boolean(),
  reason: z.string().optional(),
  reasonId: z.string().optional(),
  version: z.string().optional(),
  signedIn: z.boolean().optional(),
  signInStatus: z.enum(["unknown", "signed-in", "signed-out"]).optional(),
  catalogSource: z.enum(["live", "cache", "captured", "none"]).optional(),
  catalogCheckedAt: z.string().optional(),
  catalogStale: z.boolean().optional(),
  models: z.array(
    z.object({
      id: z.string(),
      credentialId: z.string().optional(),
      provider: z.string().optional(),
      label: z.string(),
      efforts: z.array(z.string()),
      effortMode: z.enum(["selectable", "model-suffix", "none"]).optional(),
    }),
  ),
});
export type RuntimeAvailability = z.infer<typeof RuntimeAvailabilitySchema>;

export const RuntimeInfoSchema = z.object({
  reportedModel: z.string().optional(),
  reportedModelVersion: z.string().optional(),
  effortAttested: z.boolean().optional(),
  effortAttestationReason: z.string().nullable().optional(),
  runtimeKind: RuntimeKindSchema,
  version: z.string().optional(),
  sessionId: z.string().optional(),
  binding: z.string().optional(),
  historyMode: z.literal("quoted-system-context").optional(),
  launcherHash: z.string().optional(),
  configurationHash: z.string().optional(),
  requestedEffort: z.string().optional(),
  wireEffort: z.string().optional(),
  effortMappingVersion: z.string().optional(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

/** A requested pin may be incomplete; preserve it in failures instead of filling it in. */
export const RuntimePinSchema = z.object({
  runtimeKind: RuntimeKindSchema.default("pi"),
  provider: z.string().nullable(),
  modelId: z.string().nullable(),
  effort: z.string().nullable(),
  credentialId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  runtimeConfig: HermesRuntimeConfigSchema.optional(),
  runtimeConfigHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type RuntimePin = z.infer<typeof RuntimePinSchema>;

export const RuntimePinSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("group-member"),
      groupId: Id,
      memberId: Id,
      botId: Id,
    })
    .strict(),
  z.object({ kind: z.literal("bot"), botId: Id }).strict(),
  z.object({ kind: z.literal("space-default"), spaceId: Id, botId: Id }).strict(),
]);
export type RuntimePinSource = z.infer<typeof RuntimePinSourceSchema>;

/** Serializable identity of a successfully resolved pin; adapters keep secrets separately. */
export type ResolvedPin = {
  kind: "resolved";
  pin: RuntimePin;
  provider: string;
  id: string;
  thinkingLevel: ThinkingLevel | null;
};

export const MODEL_LOCALITY_DENIED_MESSAGE =
  "This bot may only run locally — change the pin or the space policy";

export const RuntimeProblemSchema = z.object({
  kind: z.literal("problem"),
  code: z.enum([
    "pin-credential-missing",
    "pin-model-unknown",
    "pin-effort-unsupported",
    "pin-incomplete",
    "locality-denied",
    "runtime-unavailable",
    "runtime-unsupported-computer",
    "runtime-unsupported-protocol",
    "runtime-configuration-invalid",
    // The host's own local-import scan is stale, or one item is not importable; neither is
    // a lost host, so the transport must not treat them as one.
    "local-import-rescan",
    "local-import-item",
  ]),
  pin: RuntimePinSchema,
  source: RuntimePinSourceSchema.optional(),
  reason: z.string(),
  reasonId: z.string().optional(),
  actions: z.array(z.enum(["connect", "change-pin", "open-docs"])),
});
export type RuntimeProblem = z.infer<typeof RuntimeProblemSchema>;

export function runtimePinProblem(
  pin: RuntimePin,
  code: RuntimeProblem["code"],
  reason: string,
  reasonId?: string,
): RuntimeProblem {
  return {
    kind: "problem",
    code,
    pin,
    reason,
    ...(reasonId ? { reasonId } : {}),
    actions:
      code === "local-import-rescan" || code === "local-import-item"
        ? []
        : pin.runtimeKind === "pi" && code === "pin-credential-missing"
          ? ["connect", "change-pin"]
          : ["change-pin"],
  };
}

export function runtimePinMessage(
  pin: RuntimePin,
  labels?: { provider?: string; model?: string },
): string {
  const runtime =
    pin.runtimeKind && pin.runtimeKind !== "pi" ? `${runtimeNames[pin.runtimeKind]} · ` : "";
  const effort =
    pin.provider === "ollama"
      ? pin.effort === null
        ? "effort not applicable"
        : pin.effort === "none" || pin.effort === "off"
          ? "thinking off"
          : "thinking on"
      : (pin.effort ?? "an unset effort");
  const recovery =
    pin.runtimeKind === "pi"
      ? "connect it or change the pin"
      : "check the runtime or change the pin";
  return `This bot is pinned to ${runtime}${labels?.provider ?? pin.provider ?? "an unset provider"} · ${labels?.model ?? pin.modelId ?? "an unset model"} · ${effort}; ${recovery}.`;
}

/** Carries a configuration failure across adapter boundaries without losing its type. */
export class RuntimePinError<
  P extends Omit<RuntimeProblem, "pin"> & {
    pin: Omit<RuntimePin, "runtimeKind"> & { runtimeKind: string };
  } = RuntimeProblem,
> extends Error {
  constructor(readonly problem: P) {
    super(
      problem.pin.runtimeKind !== "pi" || problem.code !== "pin-credential-missing"
        ? problem.reason
        : runtimePinMessage({ ...problem.pin, runtimeKind: "pi" }),
    );
    this.name = "RuntimePinError";
  }
}
