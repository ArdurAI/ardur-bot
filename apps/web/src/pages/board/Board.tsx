import type { Bot } from "@ardurbot/contracts";
import type {
  BoardFilter,
  BoardGraph,
  BoardProblem,
  BoardSnapshot,
  BoardWorkspace,
  WorkItem,
} from "@ardurbot/contracts/board";
import { BOARD_TYPES, BoardCreateSchema, boardColumn } from "@ardurbot/contracts/board";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  NativeSelect,
  Switch,
  Textarea,
} from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LoadingState } from "../../components/ai/primitives";
import { rpc } from "../../lib/rpc";
import { DependencyGraph } from "./Graph";
import { ItemForm } from "./ItemForm";

const empty: BoardSnapshot = { items: [], readyIds: [], blockedIds: [] };
export function Board({
  navigation,
  bots = [],
}: {
  navigation?: ReactNode;
  bots?: Pick<Bot, "id" | "name">[];
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const closeSwitchId = useId();
  const [workspaces, setWorkspaces] = useState<BoardWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [problem, setProblem] = useState<BoardProblem | null>(null);
  const [snapshot, setSnapshot] = useState(empty);
  const [filter, setFilter] = useState<BoardFilter>({});
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newItem, setNewItem] = useState(false);
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [graph, setGraph] = useState<BoardGraph | null>(null);
  const [view, setView] = useState("board");
  const [exportPath, setExportPath] = useState("");
  const [preview, setPreview] = useState(false);
  const epoch = useRef(0);
  const catalog = snapshot.allItems ?? snapshot.items;
  const workspace = workspaces.find((row) => row.id === workspaceId);
  const loadWorkspaces = useCallback(async () => {
    const result = await rpc.board.workspaces({});
    setWorkspaces(result.workspaces);
    setProblem(result.problem);
    setWorkspaceId((current) =>
      result.workspaces.some((row) => row.id === current)
        ? current
        : (result.workspaces.find((row) => row.kind === "space")?.id ?? ""),
    );
    setLoaded(true);
  }, []);
  useEffect(() => {
    void loadWorkspaces().catch((e) => {
      setError(e.message);
      setLoaded(true);
    });
  }, [loadWorkspaces]);
  const refresh = useCallback(async () => {
    if (!workspaceId || !workspace?.initialized) return;
    const ticket = ++epoch.current;
    const result = await rpc.board.snapshot({ workspaceId, filter, search: search || undefined });
    if (ticket === epoch.current) {
      setSnapshot(result);
      setError("");
    }
    if (view === "graph") {
      const nextGraph = await rpc.board.graph({ workspaceId, rootId: filter.parent });
      if (ticket === epoch.current) setGraph(nextGraph);
    }
  }, [workspaceId, workspace?.initialized, filter, search, view]);
  useEffect(() => {
    setSnapshot(empty);
    setSelected(null);
    setGraph(null);
    setExportPath("");
    const timer = setTimeout(() => void refresh().catch((e) => setError(e.message)), 200);
    const interval = setInterval(() => void refresh().catch((e) => setError(e.message)), 15_000);
    return () => {
      ++epoch.current;
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [refresh]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t`Could not update this item.`);
    } finally {
      setBusy(false);
    }
  };
  const open = async (id: string) => {
    setEditing(false);
    setComment("");
    setSelected(await rpc.board.show({ workspaceId, id }));
  };
  const updateFilter = (key: keyof BoardFilter, value: string) =>
    setFilter((previous) => ({ ...previous, [key]: value || undefined }));
  const chosenBot = bots.find((bot) => bot.id === botId) ?? bots[0];
  return (
    <section className="relative min-h-0 flex-1 overflow-auto p-4" aria-label={t`Board`}>
      <header className="mb-4 flex flex-wrap items-center gap-2">
        {navigation}
        <h1 className="text-lg font-medium">
          <Trans>Board</Trans>
        </h1>
        {workspaces.length ? (
          <NativeSelect
            aria-label={t`Board`}
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
          >
            {workspaces
              .filter((row) => row.enabled)
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
          </NativeSelect>
        ) : null}
        {workspace?.initialized ? (
          <>
            <Button onClick={() => setNewItem(true)}>
              <Trans>New item</Trans>
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void act(async () => setExportPath((await rpc.board.export({ workspaceId })).path))
              }
            >
              <Trans>Export</Trans>
            </Button>
          </>
        ) : null}
      </header>
      {!loaded ? <LoadingState label={t`Loading…`} /> : null}
      {problem ? (
        <div role="alert" className="space-y-2">
          <p>{problem.message}</p>
          {problem.code === "not_installed" ? (
            <>
              <a
                href="https://github.com/gastownhall/beads#installation"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                <Trans>Install Beads</Trans>
              </a>
              <pre className="rounded-lg bg-muted p-2">brew install beads</pre>
              <pre className="rounded-lg bg-muted p-2">npm install -g @beads/bd</pre>
            </>
          ) : null}
          <Button variant="outline" onClick={() => void act(loadWorkspaces)}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="my-2 text-destructive">
          {error}{" "}
          <Button variant="ghost" onClick={() => void act(workspace ? refresh : loadWorkspaces)}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {exportPath ? <output className="my-2 block break-all text-sm">{exportPath}</output> : null}
      {workspace && !workspace.initialized ? (
        <>
          <p className="mb-2">
            <Trans>This folder has no board</Trans>
          </p>
          <Button onClick={() => setPreview(true)}>
            <Trans>Start a board in this folder</Trans>
          </Button>
        </>
      ) : null}
      {workspace?.initialized ? (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            <Input
              className="w-48"
              aria-label={t`Search`}
              placeholder={t`Search`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <NativeSelect
              aria-label={t`Type`}
              value={filter.type ?? ""}
              onChange={(e) => updateFilter("type", e.target.value)}
            >
              <option value="">{t`Type`}</option>
              {BOARD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </NativeSelect>
            <Input
              className="w-32"
              aria-label={t`Label`}
              placeholder={t`Label`}
              value={filter.label ?? ""}
              onChange={(e) => updateFilter("label", e.target.value)}
            />
            <Input
              className="w-40"
              aria-label={t`Assignee`}
              placeholder={t`Assignee`}
              value={filter.assignee ?? ""}
              onChange={(e) => updateFilter("assignee", e.target.value)}
            />
            <NativeSelect
              aria-label={t`Epic`}
              value={filter.parent ?? ""}
              onChange={(e) => updateFilter("parent", e.target.value)}
            >
              <option value="">{t`Epic`}</option>
              {catalog
                .filter((item) => item.type === "epic")
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
            </NativeSelect>
            <NativeSelect
              aria-label={t`View`}
              value={view}
              onChange={(e) => setView(e.target.value)}
            >
              <option value="board">{t`Board`}</option>
              <option value="graph">{t`Dependencies`}</option>
              <option value="epics">{t`Epics`}</option>
            </NativeSelect>
          </div>
          {view === "graph" && graph ? (
            <DependencyGraph graph={graph} onOpen={(id) => void act(() => open(id))} />
          ) : view === "epics" ? (
            <div className="space-y-2">
              {catalog
                .filter((item) => item.type === "epic")
                .map((epic) => {
                  const children = catalog.filter((item) => item.parent === epic.id);
                  const done = children.filter((item) => item.status === "closed").length;
                  return (
                    <article key={epic.id} className="rounded-lg border border-border bg-card p-4">
                      <Button variant="ghost" onClick={() => void act(() => open(epic.id))}>
                        {epic.title}
                      </Button>
                      <span className="ms-2 text-muted-foreground">
                        {done}/{children.length}
                      </span>
                      <progress
                        className="block w-full"
                        value={done}
                        max={children.length || 1}
                        aria-label={epic.title}
                      />
                      {children.map((child) => (
                        <Button
                          key={child.id}
                          variant="ghost"
                          onClick={() => void act(() => open(child.id))}
                        >
                          {child.title}
                        </Button>
                      ))}
                    </article>
                  );
                })}
            </div>
          ) : (
            <BoardColumns snapshot={snapshot} onOpen={(id) => void act(() => open(id))} />
          )}
        </>
      ) : null}
      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent>
          <DialogTitle>
            <Trans>Start a board in this folder</Trans>
          </DialogTitle>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          <p className="break-all">{workspace?.path}/.beads/</p>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Creates .beads/ with config.yaml, metadata.json, .gitignore, README.md,
              interactions.jsonl, .local_version, and embeddeddolt/. Git files and hooks stay
              unchanged.
            </Trans>
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await rpc.board.start({ workspaceId });
                setPreview(false);
                await loadWorkspaces();
              })
            }
          >
            <Trans>Start a board in this folder</Trans>
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={newItem} onOpenChange={setNewItem}>
        <DialogContent className="max-h-full overflow-auto sm:max-w-xl">
          <DialogTitle>
            <Trans>New item</Trans>
          </DialogTitle>
          <ItemForm
            items={catalog}
            bots={bots}
            save={async (item) => {
              await rpc.board.create({ workspaceId, item: BoardCreateSchema.parse(item) });
              setNewItem(false);
              await refresh();
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="inset-y-0 left-auto right-0 top-0 h-full max-w-full translate-x-0 translate-y-0 overflow-auto rounded-none sm:max-w-xl">
          <DialogTitle>{selected?.title}</DialogTitle>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          {selected ? (
            <>
              {editing ? (
                <ItemForm
                  item={selected}
                  items={catalog}
                  bots={bots}
                  save={async ({ dependencies: _dependencies, ...patch }) => {
                    setSelected(await rpc.board.update({ workspaceId, id: selected.id, patch }));
                    setEditing(false);
                    await refresh();
                  }}
                />
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {selected.id} · P{selected.priority} · {selected.type}
                  </p>
                  <p className="whitespace-pre-wrap">{selected.description}</p>
                  {selected.acceptanceCriteria ? (
                    <div>
                      <h2 className="font-medium">
                        <Trans>Acceptance criteria</Trans>
                      </h2>
                      <p className="whitespace-pre-wrap">{selected.acceptanceCriteria}</p>
                    </div>
                  ) : null}
                  <Button variant="outline" onClick={() => setEditing(true)}>
                    <Trans>Edit</Trans>
                  </Button>
                </>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || selected.status === "closed"}
                  onClick={() =>
                    void act(async () => {
                      await rpc.board.claim({ workspaceId, id: selected.id });
                      await open(selected.id);
                    })
                  }
                >
                  <Trans>Claim</Trans>
                </Button>
                <Button
                  disabled={busy || selected.status === "closed"}
                  onClick={() =>
                    void act(async () => {
                      await rpc.board.close({
                        workspaceId,
                        ids: [selected.id],
                        reason: "Completed",
                      });
                      await open(selected.id);
                    })
                  }
                >
                  <Trans>Close</Trans>
                </Button>
              </div>
              {chosenBot ? (
                <div className="flex flex-wrap gap-2">
                  <NativeSelect
                    aria-label={t`Bot`}
                    value={chosenBot.id}
                    onChange={(e) => setBotId(e.target.value)}
                  >
                    {bots.map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button
                    disabled={busy || selected.status === "closed"}
                    onClick={() =>
                      void act(async () => {
                        await rpc.board.send({
                          workspaceId,
                          id: selected.id,
                          botId: chosenBot.id,
                          clientNonce: crypto.randomUUID(),
                        });
                        navigate(`/app/${chosenBot.id}`);
                      })
                    }
                  >
                    <Trans>Send to {chosenBot.name}</Trans>
                  </Button>
                </div>
              ) : null}
              <label htmlFor={closeSwitchId} className="flex items-center gap-2">
                <Switch
                  id={closeSwitchId}
                  checked={selected.closeWhenDone}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    void act(async () =>
                      setSelected(
                        await rpc.board.update({
                          workspaceId,
                          id: selected.id,
                          patch: { closeWhenDone: checked },
                        }),
                      ),
                    )
                  }
                />
                <span>
                  <Trans>Close when the bot reports done</Trans>
                </span>
              </label>
              {(["incoming", "outgoing"] as const).map((direction) => (
                <div key={direction}>
                  <h2 className="font-medium">
                    {direction === "incoming" ? <Trans>Blocks</Trans> : <Trans>Blocked by</Trans>}
                  </h2>
                  {selected.dependencies
                    .filter((edge) => edge.direction === direction)
                    .map((edge) => (
                      <Button
                        key={`${edge.id}:${edge.type}`}
                        variant="ghost"
                        onClick={() => void act(() => open(edge.id))}
                      >
                        {edge.id}
                        {edge.type !== "blocks" ? ` · ${edge.type}` : ""}
                      </Button>
                    ))}
                </div>
              ))}
              <details>
                <summary className="cursor-pointer">
                  <Trans>History</Trans>
                </summary>
                {selected.history.map((entry) => (
                  <p key={entry.id}>
                    {entry.message} · {entry.createdAt}
                  </p>
                ))}
              </details>
              <div className="space-y-2">
                {selected.comments.map((entry) => (
                  <article key={entry.id} className="rounded-lg border border-border p-2">
                    <p className="text-sm text-muted-foreground">
                      {entry.author} · {entry.createdAt}
                    </p>
                    <p className="whitespace-pre-wrap">{entry.text}</p>
                  </article>
                ))}
                <Textarea
                  aria-label={t`Comment`}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <Button
                  disabled={busy || !comment.trim()}
                  onClick={() =>
                    void act(async () => {
                      await rpc.board.comment({ workspaceId, id: selected.id, text: comment });
                      await open(selected.id);
                    })
                  }
                >
                  <Trans>Comment</Trans>
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
export function BoardColumns({
  snapshot,
  onOpen,
}: {
  snapshot: BoardSnapshot;
  onOpen: (id: string) => void;
}) {
  const columns = [
    { id: "ready", label: <Trans>Ready</Trans> },
    { id: "in_progress", label: <Trans>In progress</Trans> },
    { id: "blocked", label: <Trans>Blocked</Trans> },
    { id: "deferred", label: <Trans>Deferred</Trans> },
    { id: "done", label: <Trans>Done</Trans> },
  ];
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {columns.map((column) => (
        <section
          key={column.id}
          data-board-column={column.id}
          className="min-h-40 rounded-lg bg-muted/40 p-2"
        >
          <h2 className="mb-3 text-sm font-medium">{column.label}</h2>
          <div className="space-y-2">
            {snapshot.items
              .filter((item) => boardColumn(item, snapshot) === column.id)
              .map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => onOpen(item.id)}
                  className="w-full rounded-lg border border-border bg-card p-3 text-start shadow-sm focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="block font-medium">{item.title}</span>
                  <span className="mt-2 block text-xs text-muted-foreground">
                    {item.id} · P{item.priority}
                    {item.assignee ? ` · ${item.assignee}` : ""}
                  </span>
                </button>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
