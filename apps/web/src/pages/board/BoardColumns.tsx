import type { BoardPatch, BoardSnapshot, WorkItem } from "@ardurbot/contracts/board";
import { boardColumn } from "@ardurbot/contracts/board";
import { Button, Input } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { FiledBy } from "./FiledBy";

const ROW_HEIGHT = 104;
export function BoardColumns({
  snapshot,
  onOpen,
  onMove,
  onAdd,
  busy = false,
}: {
  snapshot: BoardSnapshot;
  onOpen: (id: string) => void;
  onMove?: (id: string, status: NonNullable<BoardPatch["status"]>) => void;
  onAdd?: (title: string, status: NonNullable<BoardPatch["status"]>) => Promise<void>;
  busy?: boolean;
}) {
  const columns = [
    { id: "ready", status: "open", label: <Trans>Ready</Trans> },
    { id: "in_progress", status: "in_progress", label: <Trans>In progress</Trans> },
    { id: "blocked", status: "blocked", label: <Trans>Blocked</Trans> },
    { id: "deferred", status: "deferred", label: <Trans>Deferred</Trans> },
    { id: "done", status: "closed", label: <Trans>Done</Trans> },
  ] as const;
  const membership = {
    readyIds: new Set(snapshot.readyIds),
    blockedIds: new Set(snapshot.blockedIds),
  };
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {columns.map((column) => (
        <Column
          key={column.id}
          id={column.id}
          label={column.label}
          items={snapshot.items.filter((item) => boardColumn(item, membership) === column.id)}
          onOpen={onOpen}
          busy={busy}
          onDrop={onMove ? (id) => onMove(id, column.status) : undefined}
          onAdd={onAdd ? (title) => onAdd(title, column.status) : undefined}
        />
      ))}
    </div>
  );
}
function Column({
  id,
  label,
  items,
  onOpen,
  onDrop,
  onAdd,
  busy,
}: {
  id: string;
  label: ReactNode;
  items: WorkItem[];
  onOpen: (id: string) => void;
  onDrop?: (id: string) => void;
  onAdd?: (title: string) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useLingui();
  const [title, setTitle] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const focusIndex = useRef<number | null>(null);
  const start = Math.max(0, Math.min(items.length - 1, Math.floor(scrollTop / ROW_HEIGHT)) - 3);
  const end = Math.min(items.length, start + 12);
  useEffect(() => {
    if (focusIndex.current !== null) {
      list.current
        ?.querySelector<HTMLButtonElement>(`[data-index="${focusIndex.current}"]`)
        ?.focus();
      focusIndex.current = null;
    }
  });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Drop zone; the item drawer provides a keyboard-accessible status selector.
    <section
      data-board-column={id}
      className="min-h-40 min-w-0 rounded-lg bg-muted/40 p-2"
      onDragOver={(event) => {
        if (onDrop && !busy) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        const itemId = event.dataTransfer.getData("text/ardur-board-item");
        if (itemId && !busy) onDrop?.(itemId);
      }}
    >
      <h2 className="mb-3 text-sm font-medium">
        {label} <span className="text-muted-foreground">{items.length}</span>
      </h2>
      <ul
        ref={list}
        aria-label={t`Work items`}
        className="relative max-h-[520px] overflow-y-auto"
        style={{ height: Math.min(items.length * ROW_HEIGHT, 520) }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <li aria-hidden="true" style={{ height: items.length * ROW_HEIGHT }} />
        {items.slice(start, end).map((item, offset) => (
          <li
            key={item.id}
            aria-posinset={start + offset + 1}
            aria-setsize={items.length}
            className="absolute inset-x-0"
            style={{ top: (start + offset) * ROW_HEIGHT, height: ROW_HEIGHT }}
          >
            <div className="flex h-24 flex-col overflow-hidden rounded-lg border border-border bg-card p-3 text-start shadow-sm">
              <button
                type="button"
                data-index={start + offset}
                data-board-item={item.id}
                draggable={!!onDrop && !busy}
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/ardur-board-item", item.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => onOpen(item.id)}
                className="min-h-0 flex-1 text-start focus-visible:outline-2 focus-visible:outline-ring"
                onKeyDown={(event) => {
                  const index = start + offset;
                  const next =
                    event.key === "ArrowDown"
                      ? Math.min(items.length - 1, index + 1)
                      : event.key === "ArrowUp"
                        ? Math.max(0, index - 1)
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? items.length - 1
                            : null;
                  if (next === null) return;
                  event.preventDefault();
                  const target = list.current?.querySelector<HTMLButtonElement>(
                    `[data-index="${next}"]`,
                  );
                  if (target) {
                    target.focus();
                    return;
                  }
                  focusIndex.current = next;
                  if (list.current) list.current.scrollTop = next * ROW_HEIGHT;
                  setScrollTop(next * ROW_HEIGHT);
                }}
              >
                <span className="line-clamp-2 font-medium">{item.title}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {item.id} · P{item.priority}
                  {item.assignee ? ` · ${item.assignee}` : ""}
                </span>
              </button>
              {item.filedBy ? <FiledBy filing={item.filedBy} /> : null}
            </div>
          </li>
        ))}
      </ul>
      {onAdd ? (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = title.trim();
            if (value && !busy)
              void onAdd(value).then(
                () => setTitle(""),
                () => undefined,
              );
          }}
        >
          <Input
            aria-label={t`New item`}
            placeholder={t`New item`}
            maxLength={500}
            value={title}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
          />
          {title.trim() ? (
            <Button size="sm" disabled={busy} type="submit">
              <Trans>Add</Trans>
            </Button>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
