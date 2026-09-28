import * as z from "zod";
import { DelegationRecordSchema } from "./delegation.js";
import { IdeEntrySchema, IdePathSchema } from "./ide.js";
import { Id } from "./ids.js";
import { RunActivityRowSchema } from "./runs.js";

export const WorkspaceContextSchema = z.object({
  botId: Id,
  computerId: Id.nullable(),
  generation: z.number().int().nonnegative().nullable(),
  files: z.enum(["live", "saved", "unavailable"]),
  observedAt: z.iso.datetime(),
});
export type WorkspaceContext = z.infer<typeof WorkspaceContextSchema>;

export const WorkspaceFilesSchema = z.object({
  context: WorkspaceContextSchema,
  entries: z.array(IdeEntrySchema),
});
export const WorkspaceFileSchema = z.object({
  context: WorkspaceContextSchema,
  path: IdePathSchema.min(1),
  content: z.string(),
});
export const WorkspaceTasksSchema = z.object({
  runs: z.array(
    RunActivityRowSchema.extend({
      coordinatorThreadId: Id.nullable(),
    }),
  ),
  delegations: z.array(DelegationRecordSchema),
  routines: z.array(z.object({ id: Id, name: z.string(), nextRunAt: z.string().nullable() })),
  observedAt: z.iso.datetime(),
});
export type WorkspaceTasks = z.infer<typeof WorkspaceTasksSchema>;
