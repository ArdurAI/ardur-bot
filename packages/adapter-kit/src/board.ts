import type {
  BoardComment,
  BoardCreate,
  BoardFilter,
  BoardGraph,
  BoardPatch,
  BoardWorkspace,
  WorkItem,
} from "@ardurbot/contracts/board";

/** One provider instance addresses one workspace; discovery returns reachable workspaces. */
export interface ProjectBoardProvider {
  listWorkspaces(): Promise<BoardWorkspace[]>;
  ready(filter?: BoardFilter): Promise<WorkItem[]>;
  blocked(): Promise<WorkItem[]>;
  list(filter?: BoardFilter): Promise<WorkItem[]>;
  show(id: string): Promise<WorkItem>;
  create(input: BoardCreate): Promise<WorkItem>;
  update(id: string, patch: BoardPatch): Promise<WorkItem>;
  claim(idOrFilter: string | BoardFilter, actor: string): Promise<WorkItem | null>;
  close(ids: string[], reason: string): Promise<WorkItem[]>;
  comment(id: string, text: string): Promise<BoardComment>;
  link(from: string, to: string, type: string): Promise<void>;
  graph(rootId?: string): Promise<BoardGraph>;
  search(text: string): Promise<WorkItem[]>;
  export(): Promise<{ path: string }>;
}
