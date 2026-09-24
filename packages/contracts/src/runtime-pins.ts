import * as z from "zod";
import type { ThinkingLevel } from "./domain.js";

export const RuntimeKindSchema = z.enum(["pi", "claude-code", "codex-app-server"]);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;
export const runtimeNames: Record<RuntimeKind, string> = {
  pi: "Ardur",
  "claude-code": "Claude Code",
  "codex-app-server": "Codex",
};
export const runtimeLabels: Record<RuntimeKind, string> = {
  pi: "Ardur (built-in)",
  "claude-code": "Claude Code (your claude sign-in)",
  "codex-app-server": "Codex (your ChatGPT sign-in)",
};

export const RuntimeAvailabilitySchema = z.object({
  runtimeKind: RuntimeKindSchema,
  available: z.boolean(),
  reason: z.string().optional(),
  version: z.string().optional(),
  models: z.array(z.object({ id: z.string(), label: z.string(), efforts: z.array(z.string()) })),
});
export type RuntimeAvailability = z.infer<typeof RuntimeAvailabilitySchema>;

export const RuntimeInfoSchema = z.object({
  runtimeKind: RuntimeKindSchema,
  version: z.string().optional(),
  sessionId: z.string().optional(),
  binding: z.string().optional(),
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
});
export type RuntimePin = z.infer<typeof RuntimePinSchema>;

/** Serializable identity of a successfully resolved pin; adapters keep secrets separately. */
export type ResolvedPin = {
  kind: "resolved";
  pin: RuntimePin;
  provider: string;
  id: string;
  thinkingLevel: ThinkingLevel;
};

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
  ]),
  pin: RuntimePinSchema,
  reason: z.string(),
  actions: z.array(z.enum(["connect", "change-pin", "open-docs"])),
});
export type RuntimeProblem = z.infer<typeof RuntimeProblemSchema>;

export function runtimePinProblem(
  pin: RuntimePin,
  code: RuntimeProblem["code"],
  reason: string,
): RuntimeProblem {
  return { kind: "problem", code, pin, reason, actions: ["connect", "change-pin"] };
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
  return `This bot is pinned to ${runtime}${labels?.provider ?? pin.provider ?? "an unset provider"} · ${labels?.model ?? pin.modelId ?? "an unset model"} · ${effort}; connect it or change the pin.`;
}

/** Carries a configuration failure across adapter boundaries without losing its type. */
export class RuntimePinError extends Error {
  constructor(readonly problem: RuntimeProblem) {
    super(
      problem.code === "locality-denied" || problem.code.startsWith("runtime-")
        ? problem.reason
        : runtimePinMessage(problem.pin),
    );
    this.name = "RuntimePinError";
  }
}
