import type { Bot } from "@ardurbot/contracts";
import type {
  BoardFilter,
  BoardPatch,
  BoardProblem,
  BoardSnapshot,
  BoardWorkspace,
  WorkItem,
} from "@ardurbot/contracts/board";
import {
  BOARD_STATUSES,
  BOARD_TYPES,
  BoardCreateSchema,
  BoardFilterSchema,
  BoardPatchSchema,
} from "@ardurbot/contracts/board";
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
import { useNavigate, useSearchParams } from "react-router-dom";
import { LoadingState } from "../../components/ai/primitives";
import { rpc } from "../../lib/rpc";
import { BoardColumns } from "./BoardColumns";
import { DependencyGraph } from "./Graph";
import { ItemForm } from "./ItemForm";

export { BoardColumns } from "./BoardColumns";

const empty: BoardSnapshot = { items: [], readyIds: [], blockedIds: [] };
export function Board({
  navigation,
  bots: initialBots = [],
  openSettings,
  scope = "",
  spaceId,
}: {
  navigation?: ReactNode;
  openSettings?: () => void;
  scope?: string;
  spaceId?: string;
  bots?: Pick<Bot, "id" | "name">[];
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requestedWorkspace = params.get("workspace") ?? params.get("workspaceId") ?? undefined;
  const itemId = params.get("item") ?? params.get("itemId") ?? params.get("id") ?? undefined;
  const storageKey = `ardurbot:board-filters:${scope}`;
  const [saved] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  });
  const [bots, setBots] = useState(initialBots);
  const closeSwitchId = useId();
  const [workspaces, setWorkspaces] = useState<BoardWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [problem, setProblem] = useState<BoardProblem | null>(null);
  const [selectionProblem, setSelectionProblem] = useState<BoardProblem | null>(null);
  const [snapshot, setSnapshot] = useState(empty);
  const [filter, setFilter] = useState<BoardFilter>(
    () => BoardFilterSchema.safeParse(saved.filter).data ?? {},
  );
  const [search, setSearch] = useState(typeof saved.search === "string" ? saved.search : "");
  const [botFilter, setBotFilter] = useState(typeof saved.botId === "string" ? saved.botId : "");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newItem, setNewItem] = useState(false);
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [view, setView] = useState("board");
  const [exportPath, setExportPath] = useState("");
  const [followingIds, setFollowingIds] = useState<string[]>([]);
  const [optimistic, setOptimistic] = useState<WorkItem | null>(null);
  const [undo, setUndo] = useState<{
    workspaceId: string;
    id: string;
    patch: BoardPatch;
  } | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ filter, search, botId: botFilter }));
    } catch {
      /* Storage can be unavailable. */
    }
  }, [storageKey, filter, search, botFilter]);
  const epoch = useRef(0);
  const selection = useRef({ requestedWorkspace, itemId, spaceId });
  selection.current = { requestedWorkspace, itemId, spaceId };
  const catalog = snapshot.allItems ?? snapshot.items;
  const workspace = workspaces.find((row) => row.id === workspaceId);
  useEffect(() => {
    setWorkspaceId("");
    setLoaded(false);
    setSnapshot(empty);
    setSelected(null);
    setNewItem(false);
    setEditing(false);
    setExportPath("");
    setProblem(null);
    setSelectionProblem(null);
    setError("");
  }, [requestedWorkspace]);
  const refresh = useCallback(async () => {
    if (pending.current) return pending.current;
    const abort = controller.current;
    if (!abort || abort.signal.aborted) return;
    const ticket = epoch.current;
    const current = selection.current;
    const request = rpc.board
      .view(
        { workspaceId: current.requestedWorkspace, itemId: current.itemId },
        { signal: abort.signal, context: { spaceId: current.spaceId } },
      )
      .then((result) => {
        if (abort.signal.aborted || ticket !== epoch.current) return;
        setWorkspaces(result.workspaces);
        setWorkspaceId(result.workspaceId ?? "");
        setSnapshot(result.snapshot);
        setSelected(result.selected);
        setSelectionProblem(result.selectionProblem ?? null);
        setFollowingIds(result.followingIds);
        setBots(result.bots);
        setProblem(result.problem);
        setError("");
        setLoaded(true);
      })
      .catch(() => {
        if (!abort.signal.aborted && ticket === epoch.current) {
          setError(t`Could not load Board; retry.`);
          setLoaded(true);
        }
      })
      .finally(() => {
        if (pending.current === request) pending.current = null;
      });
    pending.current = request;
    return request;
  }, [t]);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    ++epoch.current;
    const poll = async () => {
      // Await a cancelled prior selection before opening the next request.
      await pending.current;
      if (!abort.signal.aborted && !document.hidden && !mutation.current) await refresh();
    };
    void poll();
    const interval = setInterval(() => {
      if (!pending.current) void poll();
    }, 15_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      abort.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh, requestedWorkspace, itemId, spaceId]);
  const loadWorkspaces = refresh;
  const reload = async () => {
    await pending.current;
    await refresh();
  };
  const open = (id: string) => {
    setEditing(false);
    setComment("");
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("workspace", workspaceId);
      next.set("item", id);
      return next;
    });
  };
  const clearSelection = () => {
    setSelected(null);
    setSelectionProblem(null);
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const key of ["item", "itemId", "id"]) next.delete(key);
      return next;
    });
  };
  const move = async (id: string, status: NonNullable<BoardPatch["status"]>) => {
    if (mutation.current) return;
    const item = catalog.find((row) => row.id === id);
    if (!item) return;
    const oldStatus = BoardPatchSchema.shape.status.safeParse(item.status);
    const ticket = epoch.current;
    mutation.current = true;
    setBusy(true);
    setError("");
    setOptimistic({
      ...item,
      status,
      deferUntil: null,
      closedAt: status === "closed" ? new Date().toISOString() : null,
    });
    try {
      await rpc.board.update({ workspaceId, id, patch: { status, deferUntil: null } });
      if (oldStatus.success)
        setUndo({
          workspaceId,
          id,
          patch: { status: oldStatus.data, deferUntil: item.deferUntil },
        });
      await reload();
    } catch {
      setError(t`Could not update this item.`);
      if (ticket !== epoch.current) await reload();
    } finally {
      setOptimistic(null);
      setBusy(false);
      mutation.current = false;
    }
  };
  const act = async (work: () => Promise<unknown>) => {
    if (mutation.current) return;
    const ticket = epoch.current;
    mutation.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t`Could not update this item.`);
      if (ticket !== epoch.current) await reload();
    } finally {
      setBusy(false);
      mutation.current = false;
    }
  };
  const updateFilter = (key: keyof BoardFilter, value: string) =>
    setFilter((previous) => ({ ...previous, [key]: value || undefined }));
  const chosenBot = bots.find((bot) => bot.id === botId) ?? bots[0];
  const visible: BoardSnapshot = {
    ...snapshot,
    items: snapshot.items
      .map((item) => (item.id === optimistic?.id ? optimistic : item))
      .filter(
        (item) =>
          (!search ||
            `${item.title} ${item.description} ${item.id}`
              .toLowerCase()
              .includes(search.toLowerCase())) &&
          (!botFilter ||
            item.assignee === `bot:${bots.find((bot) => bot.id === botFilter)?.name}`) &&
          Object.entries(filter).every(
            ([key, value]) =>
              !value ||
              (key === "label"
                ? item.labels.includes(value)
                : item[key as "type" | "assignee" | "parent" | "status"] === value),
          ),
      ),
    readyIds: optimistic
      ? [
          ...snapshot.readyIds.filter((id) => id !== optimistic.id),
          ...(optimistic.status === "open" ? [optimistic.id] : []),
        ]
      : snapshot.readyIds,
    blockedIds: optimistic
      ? [
          ...snapshot.blockedIds.filter((id) => id !== optimistic.id),
          ...(optimistic.status === "blocked" ? [optimistic.id] : []),
        ]
      : snapshot.blockedIds,
  };
  const currentGraph = {
    items: visible.items,
    edges: visible.items.flatMap((item) =>
      item.dependencies
        .filter((edge) => edge.direction === "outgoing")
        .map((edge) => ({ from: item.id, to: edge.id, type: edge.type })),
    ),
  };
  return (
    <section className="relative min-h-0 flex-1" aria-label={t`Board`}>
      <header className="mb-4 flex flex-wrap items-center gap-2">
        {navigation}
        <h1 className="text-lg font-medium">
          <Trans>Board</Trans>
        </h1>
        {workspaces.length ? (
          <NativeSelect
            aria-label={t`Board`}
            value={requestedWorkspace ?? workspaceId}
            onChange={(e) => {
              setParams({ view: "board", workspace: e.target.value });
            }}
          >
            {workspaces
              .filter((row) => row.enabled && row.initialized)
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
      {selectionProblem ? (
        <div role="alert" className="my-2 space-x-2 text-destructive">
          <Trans>Could not load</Trans> {itemId}
          <Button variant="ghost" onClick={() => void reload()}>
            <Trans>Retry</Trans>
          </Button>
          <Button variant="ghost" onClick={clearSelection}>
            <Trans>Close</Trans>
          </Button>
        </div>
      ) : null}
      {exportPath ? <output className="my-2 block break-all text-sm">{exportPath}</output> : null}
      {loaded && !workspace && !error && !problem ? (
        <div className="space-y-2">
          <p>
            <Trans>No board</Trans>
          </p>
          <Button onClick={openSettings}>
            <Trans>Set up a board</Trans>
          </Button>
        </div>
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
              aria-label={t`Bot`}
              value={botFilter}
              onChange={(event) => setBotFilter(event.target.value)}
            >
              <option value="">{t`Bot`}</option>
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </NativeSelect>
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
          {view === "graph" ? (
            <DependencyGraph graph={currentGraph} onOpen={open} />
          ) : view === "epics" ? (
            <div className="space-y-2">
              {catalog
                .filter((item) => item.type === "epic")
                .map((epic) => {
                  const children = catalog.filter((item) => item.parent === epic.id);
                  const done = children.filter((item) => item.status === "closed").length;
                  return (
                    <article key={epic.id} className="rounded-lg border border-border bg-card p-4">
                      <Button variant="ghost" onClick={() => open(epic.id)}>
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
                        <Button key={child.id} variant="ghost" onClick={() => open(child.id)}>
                          {child.title}
                        </Button>
                      ))}
                    </article>
                  );
                })}
            </div>
          ) : (
            <BoardColumns
              snapshot={visible}
              onOpen={(id) => void open(id)}
              busy={busy}
              onMove={(id, status) => void move(id, status)}
              onAdd={async (title, status) => {
                let created: WorkItem | undefined;
                await act(async () => {
                  created = await rpc.board.create({
                    workspaceId,
                    item: { title, type: "task", priority: 2 },
                  });
                  if (status !== "open")
                    await rpc.board.update({ workspaceId, id: created.id, patch: { status } });
                });
                if (!created) throw new Error("create failed");
              }}
            />
          )}
        </>
      ) : null}
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
          if (!open) clearSelection();
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
                    await rpc.board.update({ workspaceId, id: selected.id, patch });
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
              <NativeSelect
                aria-label={t`Status`}
                value={optimistic?.id === selected.id ? optimistic.status : selected.status}
                disabled={busy}
                onChange={(event) =>
                  void move(selected.id, BoardPatchSchema.shape.status.parse(event.target.value)!)
                }
              >
                {BOARD_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status === "open"
                      ? t`Ready`
                      : status === "in_progress"
                        ? t`In progress`
                        : status === "blocked"
                          ? t`Blocked`
                          : status === "closed"
                            ? t`Done`
                            : status === "deferred"
                              ? t`Deferred`
                              : status === "pinned"
                                ? t`Pinned`
                                : t`Hooked`}
                  </option>
                ))}
              </NativeSelect>
              <Button
                variant="outline"
                disabled={busy}
                aria-pressed={followingIds.includes(selected.id)}
                onClick={() =>
                  void act(async () => {
                    await rpc.board.follow({
                      workspaceId,
                      id: selected.id,
                      following: !followingIds.includes(selected.id),
                    });
                  })
                }
              >
                {followingIds.includes(selected.id) ? (
                  <Trans>Unfollow</Trans>
                ) : (
                  <Trans>Follow</Trans>
                )}
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || selected.status === "closed"}
                  onClick={() =>
                    void act(async () => {
                      await rpc.board.claim({ workspaceId, id: selected.id });
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
                      rpc.board.update({
                        workspaceId,
                        id: selected.id,
                        patch: { closeWhenDone: checked },
                      }),
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
                        onClick={() => open(edge.id)}
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
                      setComment("");
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
      {undo ? (
        <div
          role="status"
          className="fixed bottom-4 end-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-card p-3 shadow-sm"
        >
          <Trans>Item updated</Trans>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await rpc.board.update(undo);
                setUndo(null);
              })
            }
          >
            <Trans>Undo</Trans>
          </Button>
          <Button variant="ghost" onClick={() => setUndo(null)}>
            <Trans>Dismiss</Trans>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
