import * as z from "zod";
import { DelegationRecordSchema } from "./delegation.js";
import { IdeEntrySchema, IdePathSchema } from "./ide.js";
import { Id } from "./ids.js";
import { RunActivityRowSchema } from "./runs.js";

/** Only backed workspace views belong here; preview and plan have no renderer yet. */
export const WorkspaceViewIdSchema = z.enum([
  "tasks",
  "files",
  "terminal",
  "routines",
  "screen",
  "computer",
]);
export type WorkspaceViewId = z.infer<typeof WorkspaceViewIdSchema>;
export const WorkspaceViewSchema = z.object({ type: WorkspaceViewIdSchema }).strict();
export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>;
export const WorkspaceOpenIntentSchema = z.object({ view: WorkspaceViewSchema }).strict();
export type WorkspaceOpenIntent = z.infer<typeof WorkspaceOpenIntentSchema>;

/** Local presentation only: never persist output, credentials, drafts or session handles. */
export const WorkspaceLayoutSchema = z
  .object({
    version: z.literal(1),
    open: z.array(WorkspaceViewSchema).max(6),
    active: WorkspaceViewIdSchema.nullable(),
    visible: z.boolean(),
    expanded: z.boolean(),
    position: z.enum(["right", "left", "bottom"]),
    width: z.number().int().min(360).max(800),
    height: z.number().int().min(200).max(600),
  })
  .strict();
export type WorkspaceLayout = z.infer<typeof WorkspaceLayoutSchema>;

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
  size: z.number().nonnegative(),
  executable: z.boolean().optional(),
  binary: z.boolean(),
  readOnly: z.boolean(),
  version: z.string(),
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
