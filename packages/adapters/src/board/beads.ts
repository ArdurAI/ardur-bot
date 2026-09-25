import type { ProjectBoardProvider } from "@ardurbot/adapter-kit";
import type {
  BoardClaimFilter,
  BoardComment,
  BoardCreate,
  BoardFilter,
  BoardGraph,
  BoardPatch,
  BoardRun,
  BoardRunResult,
  BoardWorkspace,
  WorkItem,
} from "@ardurbot/contracts/board";
import {
  BoardClaimFilterSchema,
  BoardCreateSchema,
  BoardError,
  BoardFilterSchema,
  BoardItemIdSchema,
  BoardPatchSchema,
  BoardRunResultSchema,
  WorkItemSchema,
} from "@ardurbot/contracts/board";
import { getLogger } from "@ardurbot/logging";
import { z } from "zod";

export type BoardTransport = (request: BoardRun) => Promise<BoardRunResult>;
const rawObject = z.record(z.string(), z.unknown());
const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback = 0) => (typeof value === "number" ? value : fallback);
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const records = (value: unknown) => array(value).map((item) => rawObject.parse(item));
function metadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return rawObject.parse(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return rawObject.safeParse(value).success ? rawObject.parse(value) : {};
}
export function parseBeadsComment(value: unknown): BoardComment {
  const raw = rawObject.parse(value);
  return {
    id: str(raw.id),
    author: str(raw.author),
    text: str(raw.text),
    createdAt: str(raw.created_at),
  };
}
/** list/export use edge records; show uses hydrated issues with dependency_type. */
export function parseBeadsItem(value: unknown): WorkItem {
  const raw = rawObject.parse(value);
  const id = z.string().min(1).parse(raw.id);
  const dependencies: WorkItem["dependencies"] = records(raw.dependencies).map((edge) => ({
    id: str(edge.depends_on_id ?? edge.id),
    type: str(edge.type ?? edge.dependency_type, "blocks"),
    direction: "outgoing" as const,
  }));
  dependencies.push(
    ...records(raw.dependents).map((edge) => ({
      id: str(edge.issue_id ?? edge.id),
      type: str(edge.type ?? edge.dependency_type, "blocks"),
      direction: "incoming" as const,
    })),
  );
  return WorkItemSchema.parse({
    id,
    title: z.string().parse(raw.title),
    description: str(raw.description),
    acceptanceCriteria: str(raw.acceptance_criteria),
    type: str(raw.issue_type, "task"),
    status: str(raw.status, "open"),
    priority: num(raw.priority, 2),
    assignee: str(raw.assignee) || null,
    labels: array(raw.labels).map((label) => z.string().parse(label)),
    parent:
      str(raw.parent) ||
      dependencies.find((edge) => edge.type === "parent-child" && edge.direction === "outgoing")
        ?.id ||
      null,
    dependencies,
    dueAt: str(raw.due_at) || null,
    deferUntil: str(raw.defer_until) || null,
    estimateMinutes: typeof raw.estimated_minutes === "number" ? raw.estimated_minutes : null,
    externalRef: str(raw.external_ref) || null,
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
    closedAt: str(raw.closed_at) || null,
    commentCount: num(raw.comment_count, array(raw.comments).length),
    comments: array(raw.comments).map(parseBeadsComment),
    history: [],
    closeWhenDone: metadata(raw.metadata).ardur_close_when_done === true,
  });
}
export class BeadsBoardProvider implements ProjectBoardProvider {
  constructor(
    private readonly options: {
      workspace: BoardWorkspace;
      actor: string;
      run: BoardTransport;
      observe?: (items: WorkItem[]) => Promise<void>;
    },
  ) {}
  private target() {
    const workspace = this.options.workspace;
    return workspace.kind === "space"
      ? { kind: "space" as const }
      : { kind: "folder" as const, path: workspace.path };
  }
  private async request(
    action: BoardRun["action"],
    argv: string[] = [],
    actor = this.options.actor,
  ) {
    const result = BoardRunResultSchema.parse(
      await this.options.run({
        action,
        argv,
        actor,
        workspaceId: this.options.workspace.id,
        workspace: this.target(),
      }),
    );
    if (!result.ok) throw new BoardError(result.problem);
    return result;
  }
  private async json(argv: string[], actor?: string): Promise<unknown> {
    const result = await this.request("command", argv, actor);
    try {
      return JSON.parse(result.stdout ?? "null");
    } catch {
      throw new BoardError({
        code: "invalid_response",
        message: "Beads returned an unreadable response.",
      });
    }
  }
  private async items(argv: string[], actor?: string) {
    const data = await this.json(argv, actor);
    let items: WorkItem[];
    try {
      items = (data == null ? [] : Array.isArray(data) ? data : [data]).map(parseBeadsItem);
    } catch {
      throw new BoardError({
        code: "invalid_response",
        message: "Beads returned an unreadable work item.",
      });
    }
    await this.options.observe?.(items);
    return items;
  }
  private filter(input: BoardFilter = {}, ready = false) {
    const filter = BoardFilterSchema.parse(input);
    return Object.entries(filter).flatMap(([key, value]) =>
      ready && key === "status" ? [] : [`--${key}`, String(value)],
    );
  }
  async listWorkspaces() {
    return (await this.request("discover")).workspaces ?? [];
  }
  ready(filter?: BoardFilter) {
    return this.items(["ready", "--limit", "0", ...this.filter(filter, true)]);
  }
  blocked() {
    return this.items(["blocked"]);
  }
  list(filter?: BoardFilter) {
    return this.items(["list", "--all", "--limit", "0", ...this.filter(filter)]);
  }
  async show(id: string) {
    BoardItemIdSchema.parse(id);
    const item = (await this.items(["show", "--include-comments", "--include-dependents", id]))[0];
    if (!item)
      throw new BoardError({ code: "command_failed", message: "This work item was not found." });
    const history = records(await this.json(["history", id, "--limit", "100"]));
    item.history = history.map((entry) => {
      const state = rawObject.safeParse(entry.Issue);
      return {
        id: str(entry.CommitHash),
        author: str(entry.Committer),
        message: state.success ? `${str(state.data.status)} · ${str(state.data.title)}` : "",
        createdAt: str(entry.CommitDate),
      };
    });
    return item;
  }
  private fields(input: BoardPatch, create = false) {
    const names: Record<string, string> = {
      title: "title",
      description: "description",
      acceptanceCriteria: "acceptance",
      type: "type",
      status: "status",
      priority: "priority",
      assignee: "assignee",
      parent: "parent",
      dueAt: "due",
      deferUntil: "defer",
      estimateMinutes: "estimate",
      externalRef: "external-ref",
    };
    const argv = Object.entries(input).flatMap(([key, value]) =>
      names[key] ? [`--${names[key]}`, value == null ? "" : String(value)] : [],
    );
    if (input.labels !== undefined)
      argv.push(create ? "--labels" : "--set-labels", input.labels.join(","));
    if (!create && input.closeWhenDone !== undefined)
      argv.push("--set-metadata", `ardur_close_when_done=${input.closeWhenDone}`);
    return argv;
  }
  async create(input: BoardCreate) {
    const item = BoardCreateSchema.parse(input);
    const created = (await this.items(["create", ...this.fields(item, true)]))[0];
    if (!created)
      throw new BoardError({
        code: "invalid_response",
        message: "Beads did not return the new item.",
      });
    try {
      // Explicit dep add avoids the create --deps blocks shorthand, which reverses direction in 1.2.2.
      for (const dependency of item.dependencies ?? [])
        await this.link(created.id, dependency.id, dependency.type);
      if (item.closeWhenDone) await this.update(created.id, { closeWhenDone: true });
      return await this.show(created.id);
    } catch {
      throw new BoardError({
        code: "command_failed",
        message: `Item ${created.id} was created, but its details could not finish. Open it before retrying.`,
      });
    }
  }
  async update(id: string, patch: BoardPatch) {
    BoardItemIdSchema.parse(id);
    const parsed = BoardPatchSchema.parse(patch);
    if (Object.keys(parsed).length) await this.json(["update", id, ...this.fields(parsed)]);
    return this.show(id);
  }
  async claim(idOrFilter: string | BoardClaimFilter, actor: string) {
    const argv =
      typeof idOrFilter === "string"
        ? ["update", BoardItemIdSchema.parse(idOrFilter), "--claim"]
        : ["ready", "--claim", ...this.filter(BoardClaimFilterSchema.parse(idOrFilter), true)];
    return (await this.items(argv, actor))[0] ?? null;
  }
  async close(ids: string[], reason: string) {
    z.array(BoardItemIdSchema).min(1).max(50).parse(ids);
    return this.items(["close", ...ids, "--reason", reason]);
  }
  async comment(id: string, text: string) {
    BoardItemIdSchema.parse(id);
    const comment = parseBeadsComment(await this.json(["comments", "add", "--", id, text]));
    if (this.options.observe)
      await this.show(id).catch((error) => getLogger().error("board comment observation", error));
    return comment;
  }
  async link(from: string, to: string, type: string) {
    BoardItemIdSchema.parse(from);
    BoardItemIdSchema.parse(to);
    await this.json(["dep", "add", from, to, "--type", type]);
  }
  async graph(rootId?: string): Promise<BoardGraph> {
    const data = await this.json([
      "graph",
      ...(rootId ? [BoardItemIdSchema.parse(rootId)] : ["--all"]),
    ]);
    const graphs = records(Array.isArray(data) ? data : data ? [data] : []);
    const items = new Map<string, WorkItem>();
    const edges = new Map<string, BoardGraph["edges"][number]>();
    for (const graph of graphs) {
      for (const raw of array(graph.Issues)) {
        const item = parseBeadsItem(raw);
        items.set(item.id, item);
      }
      for (const raw of records(graph.Dependencies)) {
        const edge = { from: str(raw.issue_id), to: str(raw.depends_on_id), type: str(raw.type) };
        edges.set(`${edge.from}:${edge.to}:${edge.type}`, edge);
      }
    }
    return { items: [...items.values()], edges: [...edges.values()] };
  }
  search(text: string) {
    return this.items(["search", "--query", text, "--status", "all", "--limit", "0"]);
  }
  async export() {
    const result = await this.request("export");
    if (!result.path)
      throw new BoardError({
        code: "invalid_response",
        message: "Beads did not return an export path.",
      });
    return { path: result.path };
  }
}
