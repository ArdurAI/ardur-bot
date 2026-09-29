import type { Bot, ScratchpadItem } from "@ardurbot/contracts";
import type { BoardWorkspace, WorkItem } from "@ardurbot/contracts/board";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  NativeSelect,
} from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { rpc } from "../lib/rpc";
import { ItemForm } from "./board/ItemForm";

function NewWorkItemDialog({
  botId,
  open,
  onOpenChange,
  workspaces,
  bots,
  onAdded,
}: {
  botId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: BoardWorkspace[];
  bots: Pick<Bot, "id" | "name">[];
  onAdded: () => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(
    workspaces.find((w) => w.isDefault)?.id ?? workspaces[0]?.id,
  );
  const [snapshotItems, setSnapshotItems] = useState<WorkItem[]>([]);

  useEffect(() => {
    if (open && workspaceId) {
      void rpc.board
        .snapshot({ workspaceId })
        .then((s) => setSnapshotItems(s.items))
        .catch(() => setSnapshotItems([]));
    }
  }, [workspaceId, open]);

  const save = async (data: any) => {
    if (!workspaceId) return;
    const res = await rpc.board.create({
      workspaceId,
      ...data,
    });
    await rpc.scratchpad.linkBoardItems({
      botId,
      boardWorkspaceId: workspaceId,
      boardItemIds: [res.id],
    });
    onAdded();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="flex items-center gap-2">
          <Trans>New work item</Trans>
        </DialogTitle>
        <div className="space-y-4 pt-2">
          <label className="block space-y-1" htmlFor="new-item-board-select">
            <span>
              <Trans>Board</Trans>
            </span>
            <NativeSelect
              id="new-item-board-select"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <ItemForm items={snapshotItems} bots={bots} save={save as any} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddFromBoardDialog({
  botId,
  open,
  onOpenChange,
  workspaces,
  onAdded,
}: {
  botId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: BoardWorkspace[];
  onAdded: () => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(
    workspaces.find((w) => w.isDefault)?.id ?? workspaces[0]?.id,
  );
  const [snapshotItems, setSnapshotItems] = useState<WorkItem[]>([]);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [existingLinkedIds, setExistingLinkedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open && workspaceId) {
      void rpc.board
        .snapshot({ workspaceId, search })
        .then((s) =>
          setSnapshotItems(s.items.filter((i) => i.status !== "closed" && i.status !== "done")),
        )
        .catch(() => setSnapshotItems([]));
      void rpc.scratchpad.list({ botId }).then((items) => {
        setExistingLinkedIds(
          new Set(
            items
              .filter((i) => i.boardWorkspaceId === workspaceId && i.boardItemId)
              .map((i) => i.boardItemId!),
          ),
        );
      }).catch(console.error);
    }
  }, [workspaceId, search, open, botId]);

  const add = async () => {
    if (!workspaceId || selectedIds.size === 0) return;
    setBusy(true);
    try {
      await rpc.scratchpad.linkBoardItems({
        botId,
        boardWorkspaceId: workspaceId,
        boardItemIds: Array.from(selectedIds),
      });
      onAdded();
      onOpenChange(false);
      setSelectedIds(new Set());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] flex flex-col">
        <DialogTitle>
          <Trans>Add from board</Trans>
        </DialogTitle>
        <div className="flex gap-2 pt-2 shrink-0">
          <NativeSelect
            id="add-item-board-select"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </NativeSelect>
          <Input
            placeholder={t`Search`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
          />
        </div>
        <div className="flex-1 overflow-auto min-h-0 py-2 space-y-1">
          {snapshotItems.map((item) => {
            const alreadyLinked = existingLinkedIds.has(item.id);
            const isSelected = selectedIds.has(item.id);
            return (
              <label
                key={item.id}
                htmlFor={`board-item-${item.id}`}
                className="flex items-center gap-3 p-2 hover:bg-accent rounded-lg cursor-pointer"
              >
                <Checkbox
                  id={`board-item-${item.id}`}
                  checked={alreadyLinked || isSelected}
                  disabled={alreadyLinked || busy}
                  onCheckedChange={(checked) => {
                    if (alreadyLinked) return;
                    const next = new Set(selectedIds);
                    if (checked) next.add(item.id);
                    else next.delete(item.id);
                    setSelectedIds(next);
                  }}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-start text-[14.5px] text-foreground" dir="auto">
                    {item.title}
                  </div>
                </div>
                <span className="shrink-0 text-[12px] text-muted-foreground">{item.type}</span>
                <span className="shrink-0 text-[12px] text-muted-foreground shrink-0">
                  {item.status}
                </span>
              </label>
            );
          })}
        </div>
        <div className="flex justify-end gap-2 shrink-0 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={busy || selectedIds.size === 0} onClick={() => void add()}>
            <Trans>Add</Trans>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ScratchpadSection({ botId }: { botId: string }) {
  const [items, setItems] = useState<ScratchpadItem[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listGeneration = useRef(0);

  const [workspaces, setWorkspaces] = useState<BoardWorkspace[]>([]);
  const [bots, setBots] = useState<Pick<Bot, "id" | "name">[]>([]);
  const [addFromBoardOpen, setAddFromBoardOpen] = useState(false);
  const [newWorkItemOpen, setNewWorkItemOpen] = useState(false);

  useEffect(() => {
    void refresh();
    void rpc.board.view({}).then((v) => {
      setBots(v.bots);
      setWorkspaces(
        v.workspaces.filter(
          (w) => w.enabled && (w.allowAllBots || w.allowedBotIds.includes(botId)),
        ),
      );
    });
  }, [botId]);

  async function refresh() {
    const gen = ++listGeneration.current;
    try {
      const list = await rpc.scratchpad.list({ botId, includeDone: true });
      if (listGeneration.current === gen) setItems(list);
    } catch {
      // ignore
    }
  }

  async function addItem() {
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.scratchpad.create({ botId, title: draft });
      setDraft("");
      try {
        await refresh();
      } catch {
        setError(t`Saved, but list refresh failed`);
      }
    } catch {
      setError(t`Could not add`);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(item: ScratchpadItem, status: "open" | "done" | "parked") {
    setBusy(true);
    setError(null);
    try {
      await rpc.scratchpad.update({ itemId: item.id, status });
      try {
        await refresh();
      } catch {
        setError(t`Saved, but list refresh failed`);
      }
    } catch {
      setError(t`Could not update`);
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(item: ScratchpadItem) {
    setBusy(true);
    setError(null);
    try {
      await rpc.scratchpad.remove({ itemId: item.id });
      try {
        await refresh();
      } catch {
        setError(t`Removed, but list refresh failed`);
      }
    } catch {
      setError(t`Could not remove`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6" data-testid="bot-scratchpad">
      <div className="mb-3 text-[14px] text-muted-foreground">
        <Trans>Open work</Trans>
      </div>
      {items.length === 0 ? (
        <div className="py-1 text-[13.5px] text-muted-foreground/80">
          <Trans>None yet</Trans>
        </div>
      ) : (
        items.map((item) => (
          <div
            key={item.id}
            className="flex w-full items-start gap-2 rounded-xl px-2.5 py-2.5 hover:bg-accent"
          >
            <Checkbox
              aria-label={item.status === "done" ? t`Reopen` : t`Complete`}
              checked={item.status === "done"}
              disabled={busy}
              onCheckedChange={(checked) => void setStatus(item, checked ? "done" : "open")}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <div
                className={`text-start text-[14.5px] ${item.status === "done" ? "text-muted-foreground/80 line-through" : "text-foreground"}`}
                dir="auto"
              >
                {item.title}
              </div>
              {item.notes ? (
                <div className="mt-0.5 text-[12.5px] text-muted-foreground/80" dir="auto">
                  {item.notes}
                </div>
              ) : null}
            </div>
            <span className="shrink-0 text-[12px] text-muted-foreground/80">{item.status}</span>
            {item.boardWorkspaceId && item.boardItemId ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t`Open in board`}
                className="shrink-0 text-muted-foreground/70"
                onClick={() =>
                  window.open(`/board/${item.boardWorkspaceId}/${item.boardItemId}`, "_blank")
                }
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </Button>
            ) : null}
            {item.status === "open" ? (
              <Button
                variant="ghost"
                size="xs"
                aria-label={t`Park`}
                disabled={busy}
                onClick={() => void setStatus(item, "parked")}
                className="shrink-0 text-muted-foreground/70"
              >
                <Trans>Park</Trans>
              </Button>
            ) : item.status === "parked" ? (
              <Button
                variant="ghost"
                size="xs"
                aria-label={t`Reopen`}
                disabled={busy}
                onClick={() => void setStatus(item, "open")}
                className="shrink-0 text-muted-foreground/70"
              >
                <Trans>Open</Trans>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t`Remove`}
              disabled={busy}
              onClick={() => void removeItem(item)}
              className="shrink-0 text-muted-foreground/70"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        ))
      )}
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void addItem();
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t`Add item`}
          aria-label={t`New open-work item`}
          maxLength={200}
          className="min-w-0 flex-1"
        />
        <Button
          variant="secondary"
          className="rounded-full"
          disabled={busy || !draft.trim()}
          type="submit"
        >
          <Trans>Add</Trans>
        </Button>
        {workspaces.length > 0 && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddFromBoardOpen(true)}
              className="rounded-full"
              type="button"
            >
              <Trans>Add from board</Trans>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNewWorkItemOpen(true)}
              className="rounded-full"
              type="button"
            >
              <Trans>New work item</Trans>
            </Button>
            <AddFromBoardDialog
              botId={botId}
              open={addFromBoardOpen}
              onOpenChange={setAddFromBoardOpen}
              workspaces={workspaces}
              onAdded={refresh}
            />
            <NewWorkItemDialog
              botId={botId}
              open={newWorkItemOpen}
              onOpenChange={setNewWorkItemOpen}
              workspaces={workspaces}
              bots={bots}
              onAdded={refresh}
            />
          </>
        )}
      </form>
      {error ? <div className="mt-2 text-[13px] text-destructive">{error}</div> : null}
    </div>
  );
}
