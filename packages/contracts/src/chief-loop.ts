import { z } from "zod";
import { Id } from "./ids.js";
import { TaskTypeSchema } from "./task-types.js";

export const ChiefReceiptKeySchema = z.enum([
  "document-to-service",
  "install-tool",
  "general",
  "greeting",
  "exclude-member",
  "change-task",
]);
export type ChiefReceiptKey = z.infer<typeof ChiefReceiptKeySchema>;
export const ChiefOperationSchema = z.object({
  taskType: TaskTypeSchema,
  purpose: z.enum(["document-to-service", "install-tool", "general"]),
});
export type ChiefOperation = z.infer<typeof ChiefOperationSchema>;

export const ChiefReceiptSchema = z.object({
  id: Id,
  threadId: Id,
  seq: z.number().int().nonnegative(),
  botId: Id,
  requestMessageId: Id,
  key: ChiefReceiptKeySchema,
  memberName: z.string().optional(),
  text: z.string(),
  createdAt: z.string(),
});
export type ChiefReceipt = z.infer<typeof ChiefReceiptSchema>;

/** Legacy work responses remain readable; only receipt-only explicitly has no run. */
export const ThreadSendResultSchema = z.union([
  z.object({
    kind: z.literal("work").optional(),
    taskId: Id,
    runId: Id,
    seq: z.number().int(),
    runIds: z.array(Id).optional(),
    receipt: ChiefReceiptSchema.optional(),
  }),
  z.object({
    kind: z.literal("receipt-only"),
    seq: z.number().int(),
    receipt: ChiefReceiptSchema,
  }),
]);
export type ThreadSendResult = z.infer<typeof ThreadSendResultSchema>;

export type ChiefCapabilityFact = {
  id: string;
  access: "known" | "missing" | "unknown";
  checkedAt: string;
};
/** Saved facts only. Descriptions never establish capability or permission. */
export type ChiefMemberFacts = {
  id: string;
  name: string;
  role: string;
  skills: readonly { id: string; descriptor: string }[];
  capabilities: readonly ChiefCapabilityFact[];
  authorized: boolean;
  runtimeSupported: boolean;
  pin: { runtime: string; model: string | null; effort: string | null; revision: number };
  computer: { id: string; kind: string; state: string; local: boolean; leaseBusy: boolean } | null;
  inputAccess: "known" | "missing" | "unknown";
  activeRuns: number;
  queuedRuns: number;
  runLimit: number;
  membershipRevision: string;
};
export type ChiefDecision =
  | { kind: "self" }
  | { kind: "delegate" | "queue"; memberId: string; reason: string }
  | { kind: "needs-owner"; blocker: string }
  | { kind: "plan" };

export const ChiefActivityKeySchema = z.enum([
  "read-input",
  "connect-notion",
  "write-notion",
  "verify-notion",
  "check-tool",
  "working",
  "waiting-tool",
]);
export type ChiefActivityKey = z.infer<typeof ChiefActivityKeySchema>;
export const ChiefActivitySchema = z.object({
  revision: z.number().int().positive(),
  runId: Id,
  delegationId: Id,
  attempt: z.number().int().nonnegative(),
  sourceSeq: z.number().int().nonnegative(),
  executionId: z.string().max(200).optional(),
  key: ChiefActivityKeySchema,
  state: z.enum(["active", "idle", "waiting", "completed", "failed", "stopped"]),
  updatedAt: z.string(),
});
export type ChiefActivity = z.infer<typeof ChiefActivitySchema>;
export const ChiefResultSchema = z.object({
  requestMessageId: Id,
  revision: z.number().int().positive(),
  artifactId: Id,
  href: z.string(),
  state: z.enum(["draft", "verified-notion"]),
});
export type ChiefResult = z.infer<typeof ChiefResultSchema>;
export const ChiefStopSchema = z.object({
  revision: z.number().int().positive(),
  memberName: z.string(),
  state: z.enum(["requested", "confirmed", "uncertain", "checking"]),
});
export type ChiefStop = z.infer<typeof ChiefStopSchema>;
export const ChiefDispatchSchema = z.object({
  requestMessageId: Id,
  revision: z.number().int().positive(),
  memberId: Id,
  memberName: z.string(),
  state: z.enum(["messaged", "queued", "approval-held"]),
  reason: z.string(),
  runId: Id.optional(),
  delegationId: Id.optional(),
  activity: ChiefActivitySchema.optional(),
  stop: ChiefStopSchema.optional(),
});
export type ChiefDispatch = z.infer<typeof ChiefDispatchSchema>;

export const ChiefCorrectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exclude"), memberId: Id, memberName: z.string() }),
  z.object({ kind: z.literal("local-only") }),
  z.object({ kind: z.literal("stop") }),
  z.object({ kind: z.literal("replan") }),
]);
export type ChiefCorrection = z.infer<typeof ChiefCorrectionSchema>;
export const ChiefActionReconciliationSchema = z.object({
  runId: Id,
  effectId: Id.nullable(),
  executionId: z.string().optional(),
  outcome: z.enum(["kept", "undone", "unknown"]),
  revision: z.number().int().positive(),
});
export type ChiefActionReconciliation = z.infer<typeof ChiefActionReconciliationSchema>;
export const ReconcileChiefActionInputSchema = z.object({
  runId: Id,
  effectId: Id.nullable(),
  executionId: z.string().optional(),
  outcome: z.enum(["kept", "undone", "unknown"]),
  verificationExecutionId: z.string().optional(),
});
/** Control never carries a permission, connector grant, pin or increased budget. */
export const ChiefControlSchema = z.object({
  revision: z.number().int().positive(),
  ownerMessageIds: z.array(Id),
  excludedIds: z.array(Id),
  localOnly: z.boolean(),
  stopped: z.boolean(),
  pendingReplan: z.boolean(),
  stoppingRunIds: z.array(Id),
  uncertainRunIds: z.array(Id),
  uncertaintySince: z.string().datetime().optional(),
  reconciliationRunId: Id.optional(),
  reconciledActions: z.array(ChiefActionReconciliationSchema).optional(),
});
export type ChiefControl = z.infer<typeof ChiefControlSchema>;
