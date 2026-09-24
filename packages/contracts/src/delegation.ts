import { oc } from "@orpc/contract";
import * as z from "zod";
import { RuntimePinSchema } from "./runtime-pins.js";

export const DelegationKindSchema = z.enum(["message", "group-handoff", "helper", "child"]);
export type DelegationKind = z.infer<typeof DelegationKindSchema>;
export const DelegationStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "accepted",
  "failed",
  "cancel-requested",
  "cancelled",
]);
export const LocalityPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("any") }),
  z.object({ mode: z.literal("local") }),
  z.object({
    mode: z.literal("hosts"),
    hosts: z.array(z.string().trim().min(1).max(253)).min(1).max(64),
  }),
]);
export type LocalityPolicy = z.infer<typeof LocalityPolicySchema>;
export const ModelDestinationSchema = z.object({ host: z.string().nullable(), local: z.boolean() });
export type ModelDestination = z.infer<typeof ModelDestinationSchema>;
export const DelegationAuthoritySchema = z.object({
  scopes: z.array(z.string()),
  connectors: z.array(z.string()),
});
export type DelegationAuthority = z.infer<typeof DelegationAuthoritySchema>;
export const DelegationSnapshotSchema = z.object({
  pin: RuntimePinSchema,
  computer: z.object({
    id: z.string().nullable(),
    mode: z.enum(["team", "dedicated"]),
    kind: z.string().nullable(),
  }),
  destination: ModelDestinationSchema,
});
export type DelegationSnapshot = z.infer<typeof DelegationSnapshotSchema>;
export const DelegationRecordSchema = z.object({
  id: z.string(),
  rootTaskId: z.string(),
  parentRunId: z.string(),
  runId: z.string().nullable(),
  requesterBotId: z.string(),
  actingBotId: z.string(),
  requesterName: z.string(),
  actingName: z.string(),
  kind: DelegationKindSchema,
  depth: z.number().int(),
  hop: z.number().int(),
  status: DelegationStatusSchema,
  snapshot: DelegationSnapshotSchema,
  authority: DelegationAuthoritySchema,
  differences: z.array(z.string()),
  budget: z.object({ tokens: z.number().int(), deadlineAt: z.string() }),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
});
export type DelegationRecord = z.infer<typeof DelegationRecordSchema>;
const problemCopy = {
  "depth-exceeded": [
    "This handoff exceeds the task's delegation depth; return the result to the coordinator.",
    "Return result",
  ],
  "descendants-exceeded": [
    "This task has reached its worker limit; wait for a worker or start a new task.",
    "View activity",
  ],
  "hops-exceeded": [
    "This task has reached its handoff limit; return the result to the coordinator.",
    "Return result",
  ],
  cycle: [
    "This handoff would send work back to an ancestor; return the result instead.",
    "Return result",
  ],
  "budget-exhausted": [
    "This task has no remaining worker budget; start a new task to continue.",
    "Start task",
  ],
  "deadline-passed": [
    "This task's deadline has passed or it is stopping; start a new task to continue.",
    "Start task",
  ],
  "locality-denied": [
    "This destination is outside the bot or space policy; change the pin or allowed destinations.",
    "Change pin",
  ],
  "authority-exceeded": [
    "This handoff exceeds the requester's permission; ask the owner to review access.",
    "Review access",
  ],
} as const;
export type DelegationProblem = {
  kind: "problem";
  code: keyof typeof problemCopy;
  message: string;
  action: string;
};
export function delegationProblem(code: DelegationProblem["code"]): DelegationProblem {
  const [message, action] = problemCopy[code];
  return { kind: "problem", code, message, action };
}
export const DELEGATION_LIMITS = {
  depth: 1,
  concurrent: 4,
  hops: 6,
  descendants: 12,
  tokens: 120_000,
  reservationTokens: 10_000,
  durationMs: 3_600_000,
} as const;
export const delegationsContract = {
  policy: oc.input(z.object({ botId: z.string().optional() })).output(LocalityPolicySchema),
  setPolicy: oc
    .input(z.object({ botId: z.string().optional(), policy: LocalityPolicySchema }))
    .output(z.object({ ok: z.literal(true) })),
  list: oc
    .input(z.object({ rootTaskId: z.string() }))
    .output(z.object({ delegations: z.array(DelegationRecordSchema) })),
  cancel: oc
    .input(z.object({ rootTaskId: z.string() }))
    .output(z.object({ cancelRequested: z.literal(true) })),
};
