import { z } from "zod";
import { Id } from "./ids.js";
import { TaskTypeSchema } from "./task-types.js";

export const ChiefReceiptKeySchema = z.enum([
  "document-to-service",
  "install-tool",
  "general",
  "greeting",
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

export const ChiefDispatchSchema = z.object({
  requestMessageId: Id,
  revision: z.number().int().positive(),
  memberId: Id,
  memberName: z.string(),
  state: z.enum(["messaged", "queued", "approval-held"]),
  reason: z.string(),
});
export type ChiefDispatch = z.infer<typeof ChiefDispatchSchema>;
