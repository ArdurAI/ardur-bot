import { oc } from "@orpc/contract";
import * as z from "zod";
import { DelegationRecordSchema, DelegationSnapshotSchema } from "./delegation.js";
export const TeamStateSchema = z.enum([
  "idle",
  "queued",
  "working",
  "waiting-approval",
  "blocked",
  "completed",
  "accepted",
]);
export const TeamRowSchema = z.object({
  botId: z.string(),
  botName: z.string(),
  computerName: z.string().nullable().optional(),
  threadId: z.string().nullable(),
  groupId: z.string().nullable().optional(),
  cursor: z.number().int(),
  state: TeamStateSchema,
  sentence: z.string().nullable(),
  requesterName: z.string().nullable(),
  reason: z.string().nullable(),
  action: z.string().nullable(),
  rootTaskId: z.string().nullable(),
  delegationId: z.string().nullable(),
  canStop: z.boolean(),
  canAccept: z.boolean(),
  chain: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.enum(["requester", "worker", "reviewer"]),
    }),
  ),
  delegations: z.array(DelegationRecordSchema),
  executing: DelegationSnapshotSchema.nullable(),
  usage: z.object({
    tokens: z.number().int(),
    costs: z.array(z.object({ amount: z.number(), provenance: z.string() })),
  }),
});
export type TeamRow = z.infer<typeof TeamRowSchema>;
export const TeamBoardSchema = z.object({ rows: z.array(TeamRowSchema) });
export type TeamBoard = z.infer<typeof TeamBoardSchema>;
export const teamContract = { board: oc.input(z.object({})).output(TeamBoardSchema) };
