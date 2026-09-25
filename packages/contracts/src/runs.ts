import * as z from "zod";
import { DelegationRecordSchema } from "./delegation.js";
import { Id, RunStatus, RunTriggerSchema } from "./ids.js";

export const RunActivityRowSchema = z.object({
  rootTaskId: Id.optional(),
  delegations: z.array(DelegationRecordSchema).optional(),
  runId: Id,
  botId: Id,
  botName: z.string(),
  groupId: Id.nullable(),
  groupName: z.string().nullable(),
  threadId: Id,
  externalThread: z.boolean().optional(),
  status: RunStatus,
  trigger: RunTriggerSchema,
  notificationsEnabled: z.boolean(),
  promptSnippet: z.string(),
  updatedAt: z.string(),
});
export type RunActivityRow = z.infer<typeof RunActivityRowSchema>;

export const RunsListOutputSchema = z.object({
  runs: z.array(RunActivityRowSchema),
});
export type RunsListOutput = z.infer<typeof RunsListOutputSchema>;

export const RoutineRunSchema = z.object({
  id: Id,
  status: RunStatus,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRunSchema>;
