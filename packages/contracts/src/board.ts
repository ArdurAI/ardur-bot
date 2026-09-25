import { oc } from "@orpc/contract";
import { z } from "zod";

export const BOARD_TYPES = [
  "task",
  "bug",
  "feature",
  "epic",
  "chore",
  "decision",
  "spike",
  "story",
  "milestone",
] as const;
export const BOARD_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
  "pinned",
  "hooked",
] as const;
export const BOARD_LINK_TYPES = [
  "blocks",
  "tracks",
  "related",
  "parent-child",
  "discovered-from",
  "until",
  "caused-by",
  "validates",
  "relates-to",
  "supersedes",
] as const;
export const BoardItemIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const text = z
  .string()
  .max(32_000)
  .refine((s) => !s.includes("\0"));
const label = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^,\r\n\0]+$/);
export const BoardDependencySchema = z.object({
  id: z.string(),
  type: z.string(),
  direction: z.enum(["incoming", "outgoing"]),
});
export const BoardCommentSchema = z.object({
  id: z.string(),
  author: z.string(),
  text: z.string(),
  createdAt: z.string(),
});
export const BoardHistorySchema = z.object({
  id: z.string(),
  author: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
export const WorkItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.string(),
  type: z.string(),
  status: z.string(),
  priority: z.number().int().min(0).max(4),
  assignee: z.string().nullable(),
  labels: z.array(z.string()),
  parent: z.string().nullable(),
  dependencies: z.array(BoardDependencySchema),
  dueAt: z.string().nullable(),
  deferUntil: z.string().nullable(),
  estimateMinutes: z.number().nullable(),
  externalRef: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  commentCount: z.number().int(),
  comments: z.array(BoardCommentSchema),
  history: z.array(BoardHistorySchema),
  closeWhenDone: z.boolean().default(false),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;
export type BoardComment = z.infer<typeof BoardCommentSchema>;
export const BoardWorkspaceSchema = z.object({
  id: z.string(),
  kind: z.enum(["space", "folder"]),
  path: z.string(),
  prefix: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  initialized: z.boolean(),
  isDefault: z.boolean().default(false),
  allowAllBots: z.boolean().default(true),
  allowedBotIds: z.array(z.string()).default([]),
});
export type BoardWorkspace = z.infer<typeof BoardWorkspaceSchema>;
export const BoardFilterSchema = z.object({
  type: z.enum(BOARD_TYPES).optional(),
  label: label.optional(),
  assignee: text.optional(),
  parent: BoardItemIdSchema.optional(),
  status: z.enum(BOARD_STATUSES).optional(),
});
export type BoardFilter = z.infer<typeof BoardFilterSchema>;
// Beads 1.2.x cannot combine ready --claim with --assignee. Claim assigned items by ID.
export const BoardClaimFilterSchema = BoardFilterSchema.omit({ assignee: true }).strict();
export type BoardClaimFilter = z.infer<typeof BoardClaimFilterSchema>;
export const BoardCreateSchema = z.object({
  title: text.min(1).max(500),
  description: text.optional(),
  acceptanceCriteria: text.optional(),
  type: z.enum(BOARD_TYPES).default("task"),
  priority: z.number().int().min(0).max(4).default(2),
  labels: z.array(label).max(50).optional(),
  assignee: text.max(160).optional(),
  parent: BoardItemIdSchema.optional(),
  dependencies: z
    .array(z.object({ id: BoardItemIdSchema, type: z.enum(BOARD_LINK_TYPES) }))
    .max(50)
    .optional(),
  dueAt: z.iso.datetime({ offset: true }).optional(),
  deferUntil: z.iso.datetime({ offset: true }).optional(),
  estimateMinutes: z.number().int().min(0).max(1_000_000).optional(),
  externalRef: text.max(2000).optional(),
  closeWhenDone: z.boolean().optional(),
});
export type BoardCreate = z.infer<typeof BoardCreateSchema>;
export const BoardPatchSchema = BoardCreateSchema.omit({ dependencies: true })
  .partial()
  .extend({
    type: z.enum(BOARD_TYPES).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    status: z.enum(BOARD_STATUSES).optional(),
    parent: BoardItemIdSchema.nullable().optional(),
    dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
    deferUntil: z.iso.datetime({ offset: true }).nullable().optional(),
  });
export type BoardPatch = z.infer<typeof BoardPatchSchema>;
export const BoardGraphSchema = z.object({
  items: z.array(WorkItemSchema),
  edges: z.array(z.object({ from: z.string(), to: z.string(), type: z.string() })),
});
export type BoardGraph = z.infer<typeof BoardGraphSchema>;
export const BoardProblemSchema = z.object({
  code: z.enum([
    "not_installed",
    "unsupported_version",
    "no_board",
    "busy",
    "timeout",
    "forbidden",
    "invalid_response",
    "command_failed",
    "dolt_missing",
  ]),
  message: z.string(),
});
export type BoardProblem = z.infer<typeof BoardProblemSchema>;
export class BoardError extends Error {
  constructor(readonly problem: BoardProblem) {
    super(problem.message);
    this.name = "BoardError";
  }
}

const workspaceTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("space") }),
  z.strictObject({
    kind: z.literal("folder"),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((s) => !s.includes("\0") && !s.split(/[/\\]/u).includes("..")),
  }),
]);
export const BoardRunSchema = z.strictObject({
  action: z.enum(["discover", "init", "command", "export"]),
  workspaceId: z.string().max(160).optional(),
  workspace: workspaceTarget.optional(),
  prefix: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,47}$/)
    .optional(),
  actor: z
    .string()
    .min(1)
    .max(160)
    .refine((s) => !/[\0\r\n]/u.test(s)),
  argv: z.array(text).max(128).default([]),
});
export type BoardRun = z.infer<typeof BoardRunSchema>;
export const BoardRunResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false), problem: BoardProblemSchema }),
  z.object({
    ok: z.literal(true),
    stdout: z.string().optional(),
    path: z.string().optional(),
    version: z.string().optional(),
    doltInstalled: z.boolean().optional(),
    workspaces: z.array(BoardWorkspaceSchema).optional(),
  }),
]);
export type BoardRunResult = z.infer<typeof BoardRunResultSchema>;
export const BoardSnapshotSchema = z.object({
  items: z.array(WorkItemSchema),
  readyIds: z.array(z.string()),
  blockedIds: z.array(z.string()),
  allItems: z.array(WorkItemSchema).optional(),
});
export type BoardSnapshot = z.infer<typeof BoardSnapshotSchema>;
export const BoardViewSchema = z.object({
  workspaces: z.array(BoardWorkspaceSchema),
  workspaceId: z.string().nullable(),
  snapshot: BoardSnapshotSchema,
  selected: WorkItemSchema.nullable(),
  followingIds: z.array(z.string()),
  bots: z.array(z.object({ id: z.string(), name: z.string() })),
  problem: BoardProblemSchema.nullable(),
});
export type BoardView = z.infer<typeof BoardViewSchema>;
export const BoardWorkSchema = z.object({
  workspace: BoardWorkspaceSchema.nullable(),
  ready: z.number().int(),
  inProgress: z.number().int(),
  blocked: z.number().int(),
  items: z.array(WorkItemSchema),
});
export type BoardWork = z.infer<typeof BoardWorkSchema>;
export const BoardConfigurationSchema = z.object({
  name: text.min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.literal(true).optional(),
  allowAllBots: z.boolean().optional(),
  allowedBotIds: z.array(z.string().min(1)).max(1000).optional(),
});
export type BoardConfiguration = z.infer<typeof BoardConfigurationSchema>;
const workspaceInput = z.object({ workspaceId: z.string() });
const itemInput = workspaceInput.extend({ id: BoardItemIdSchema });
export const boardContract = {
  view: oc
    .input(z.object({ workspaceId: z.string().optional(), itemId: BoardItemIdSchema.optional() }))
    .output(BoardViewSchema),
  work: oc.input(z.object({})).output(BoardWorkSchema),
  configure: oc
    .input(workspaceInput.extend({ patch: BoardConfigurationSchema }))
    .output(BoardWorkspaceSchema),
  follow: oc
    .input(itemInput.extend({ following: z.boolean() }))
    .output(z.object({ following: z.boolean() })),
  workspaces: oc.input(z.object({})).output(
    z.object({
      workspaces: z.array(BoardWorkspaceSchema),
      problem: BoardProblemSchema.nullable(),
    }),
  ),
  start: oc.input(workspaceInput).output(BoardWorkspaceSchema),
  snapshot: oc
    .input(
      workspaceInput.extend({
        filter: BoardFilterSchema.optional(),
        search: text.max(500).optional(),
      }),
    )
    .output(BoardSnapshotSchema),
  show: oc.input(itemInput).output(WorkItemSchema),
  create: oc.input(workspaceInput.extend({ item: BoardCreateSchema })).output(WorkItemSchema),
  update: oc.input(itemInput.extend({ patch: BoardPatchSchema })).output(WorkItemSchema),
  claim: oc.input(itemInput).output(WorkItemSchema.nullable()),
  close: oc
    .input(workspaceInput.extend({ ids: z.array(BoardItemIdSchema).min(1).max(50), reason: text }))
    .output(z.array(WorkItemSchema)),
  comment: oc.input(itemInput.extend({ text: text.min(1) })).output(BoardCommentSchema),
  link: oc
    .input(
      workspaceInput.extend({
        from: BoardItemIdSchema,
        to: BoardItemIdSchema,
        type: z.enum(BOARD_LINK_TYPES),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
  graph: oc
    .input(workspaceInput.extend({ rootId: BoardItemIdSchema.optional() }))
    .output(BoardGraphSchema),
  export: oc.input(workspaceInput).output(z.object({ path: z.string() })),
  send: oc
    .input(itemInput.extend({ botId: z.string(), clientNonce: z.string().min(1).max(100) }))
    .output(z.object({ runId: z.string(), botId: z.string() })),
};

/** Directions are relative to the item: outgoing depends on another item. */
export function boardColumn(
  item: WorkItem,
  snapshot: {
    readyIds: readonly string[] | ReadonlySet<string>;
    blockedIds: readonly string[] | ReadonlySet<string>;
  },
  now = Date.now(),
) {
  if (item.status === "closed")
    return item.closedAt && Date.parse(item.closedAt) >= now - 7 * 86400_000 ? "done" : null;
  if (
    item.status === "deferred" ||
    item.status === "pinned" ||
    (item.deferUntil && Date.parse(item.deferUntil) > now)
  )
    return "deferred";
  const contains = (ids: readonly string[] | ReadonlySet<string>) =>
    "has" in ids ? ids.has(item.id) : ids.includes(item.id);
  if (contains(snapshot.blockedIds) || item.status === "blocked") return "blocked";
  if (item.status === "in_progress" || item.status === "hooked") return "in_progress";
  return contains(snapshot.readyIds) ? "ready" : "blocked";
}
