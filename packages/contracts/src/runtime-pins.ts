import * as z from "zod";
import type { ThinkingLevel } from "./domain.js";

/** A requested pin may be incomplete; preserve it in failures instead of filling it in. */
export const RuntimePinSchema = z.object({
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
  ]),
  pin: RuntimePinSchema,
  reason: z.string(),
  actions: z.array(z.enum(["connect", "change-pin"])),
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
  return `This bot is pinned to ${labels?.provider ?? pin.provider ?? "an unset provider"} · ${labels?.model ?? pin.modelId ?? "an unset model"} · ${pin.effort ?? "an unset effort"}; connect it or change the pin.`;
}

/** Carries a configuration failure across adapter boundaries without losing its type. */
export class RuntimePinError extends Error {
  constructor(readonly problem: RuntimeProblem) {
    super(runtimePinMessage(problem.pin));
    this.name = "RuntimePinError";
  }
}
