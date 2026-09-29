import { oc } from "@orpc/contract";
import * as z from "zod";
import { RuntimePinSchema, RuntimePinSourceSchema } from "./runtime-pins.js";

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
  pinSource: RuntimePinSourceSchema.optional(),
  computer: z.object({
    id: z.string().nullable(),
    mode: z.enum(["team", "dedicated"]),
    kind: z.string().nullable(),
  }),
  destination: ModelDestinationSchema,
});
export type DelegationSnapshot = z.infer<typeof DelegationSnapshotSchema>;
export const TaskInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("file"), artifactId: z.string().min(1).max(200) }).strict(),
  z
    .object({
      type: z.literal("url"),
      url: z
        .url()
        .max(2000)
        .refine((value) => /^https?:\/\//u.test(value)),
    })
    .strict(),
  z
    .object({
      type: z.literal("document"),
      documentId: z.string().min(1).max(200),
      revision: z.number().int().positive(),
    })
    .strict(),
]);
/** Only task content is writable by a requester. Admission owns the remaining fields. */
export const TaskCardRequestSchema = z
  .object({
    goal: z.string().trim().min(1).max(2000),
    inputs: z.array(TaskInputSchema).max(20).default([]),
    doneWhen: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
    deadlineAt: z.iso.datetime().nullable().default(null),
  })
  .strict();
export type TaskCardRequest = z.infer<typeof TaskCardRequestSchema>;
export const TaskEventSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "created",
    "started",
    "progress",
    "artifact",
    "blocked",
    "waiting-approval",
    "completed",
    "accepted",
    "cancel-requested",
    "cancelled",
    "failed",
  ]),
  at: z.iso.datetime(),
  text: z.string().max(2000),
  action: z.string().max(200).optional(),
});
export type TaskEvent = z.infer<typeof TaskEventSchema>;
export const TaskCriterionReportSchema = z
  .object({
    index: z.number().int().min(0).max(9),
    met: z.boolean(),
    report: z.string().trim().min(1).max(500),
  })
  .strict();
export const TaskCardSchema = TaskCardRequestSchema.extend({
  /** Set by admission for restricted goal desk work, never by a caller. */
  peerMode: z.enum(["read-only", "effect-bound"]).optional(),
  requesterBotId: z.string(),
  workerBotId: z.string(),
  responsibleUserId: z.string().optional(),
  approvalBoundaries: DelegationAuthoritySchema.readonly(),
  snapshot: DelegationSnapshotSchema.readonly(),
  budget: z
    .object({ tokens: z.number().int().positive(), deadlineAt: z.iso.datetime() })
    .readonly(),
  artifacts: z.array(z.string().min(1).max(200)).max(50),
  timeline: z.array(TaskEventSchema).max(200),
  reports: z.array(TaskCriterionReportSchema).max(10).default([]),
});
export type TaskCard = z.infer<typeof TaskCardSchema>;
export const TaskProgressSchema = z
  .object({
    text: z.string().trim().min(1).max(2000),
    state: z.enum(["progress", "blocked"]).default("progress"),
    action: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (value) => value.state !== "blocked" || Boolean(value.action),
    "A blocker needs an action",
  );
export const TaskCompletionSchema = z
  .object({
    summary: z.string().trim().min(1).max(2000),
    reports: z.array(TaskCriterionReportSchema).max(10).default([]),
  })
  .strict();
export const TaskArtifactSchema = z.object({ artifactId: z.string().min(1).max(200) }).strict();
export function taskCardSentence(
  card: Pick<TaskCard, "goal" | "doneWhen" | "deadlineAt" | "workerBotId">,
  workerName = card.workerBotId,
): string {
  const plain = (text: string) =>
    text
      .replace(/\s+/gu, " ")
      .trim()
      .replace(/[.!?]+$/u, "");
  return `${plain(workerName)}: ${plain(card.goal)}${card.doneWhen.length ? ` — done when ${card.doneWhen.map(plain).join("; ")}` : ""} — ${card.deadlineAt ? `by ${card.deadlineAt.slice(11, 16)} UTC` : "no deadline"}`;
}
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
  card: TaskCardSchema.nullable().optional(),
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
  "budget-too-small": [
    "This worker's budget cannot cover one request for its model; raise the worker budget to continue.",
    "Raise budget",
  ],
  "runtime-unbudgeted": [
    "This runtime reports token usage only after the run ends, so a worker budget cannot stop it mid-run; pin a runtime that reports usage while it runs.",
    "Change pin",
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
/** Why a worker stopped; the gate and the finished card share these lines. */
export type DelegationStopReason = "budget" | "deadline" | "stopped" | "failed";
export function delegationStopLine(reason: DelegationStopReason, worker: string): string {
  if (reason === "budget")
    return `${worker} used its token budget. Raise the budget and try again.`;
  if (reason === "deadline") return `${worker} reached its deadline. Start a new task to continue.`;
  if (reason === "failed") return `${worker} failed.`;
  return "Worker stopped.";
}
/**
 * A budgeted delegation is only honest when the runtime can be stopped at its reservation:
 * - `pi` clamps every request's max_tokens to the remaining reservation and records usage
 *   per request (packages/adapters/src/pi-runtime.ts, pi-request-usage.ts);
 * - `claude-code` stream-json assistant messages carry the Anthropic BetaMessage `usage`
 *   for each request, recorded mid-run by ClaudeStreamParser
 *   (packages/host-runtime/src/runtimes/claude-code-runtime.ts);
 * - `codex-app-server` reports `thread/tokenUsage/updated` during the turn
 *   (packages/host-runtime/src/runtimes/codex-app-server-runtime.ts);
 * - `hermes` provider calls pass through the broker's per-request admission
 *   (packages/adapters/src/hermes-provider-broker.ts).
 * Antigravity's steps carry no usage and its CLI has no token cap: its stream reports usage
 * only in the terminal result event (packages/host-runtime/src/runtimes/antigravity-stream.ts),
 * so admission refuses budgeted delegation to it instead of pretending to enforce one.
 */
export function runtimeEnforcesDelegationBudget(runtimeKind: string | null | undefined): boolean {
  return runtimeKind !== "antigravity";
}
export const DELEGATION_LIMITS = {
  depth: 1,
  concurrent: 4,
  hops: 6,
  descendants: 12,
  tokens: 120_000,
  // One realistic request for a standard-context model: a full standard context
  // (DEFAULT_MODEL_CONTEXT_WINDOW) plus one output (DEFAULT_MODEL_MAX_TOKENS).
  // A smaller reservation cannot survive the worker's first request.
  reservationTokens: 36_864,
  // The reservation every attempt used before per-attempt amounts were stored.
  // Rows without a stored amount settle against this, never the current default.
  legacyReservationTokens: 10_000,
  durationMs: 3_600_000,
} as const;
export const delegationsContract = {
  accept: oc.input(z.object({ id: z.string() })).output(z.object({ accepted: z.boolean() })),
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
