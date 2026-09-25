import type { IdeEntry } from "@ardurbot/contracts";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { basename } from "./model";

export function FileTree({
  list,
  onOpen,
  onError,
  selected,
}: {
  list(path: string): Promise<IdeEntry[]>;
  onOpen(path: string): void;
  onError(error: unknown): void;
  selected?: string;
}) {
  const [entries, setEntries] = useState<IdeEntry[]>([]);
  useEffect(() => {
    let live = true;
    void list("")
      .then((rows) => {
        if (live) setEntries(rows);
      })
      .catch((error) => {
        if (live) onError(error);
      });
    return () => {
      live = false;
    };
  }, [list, onError]);
  return (
    <div role="tree" aria-label="IDE" className="min-h-0 flex-1 overflow-auto py-2 text-sm">
      {entries.map((entry) => (
        <TreeEntry
          key={`${entry.kind}:${entry.path}`}
          entry={entry}
          depth={0}
          list={list}
          onOpen={onOpen}
          onError={onError}
          selected={selected}
        />
      ))}
    </div>
  );
}
function TreeEntry({
  entry,
  depth,
  list,
  onOpen,
  onError,
  selected,
}: {
  entry: IdeEntry;
  depth: number;
  list(path: string): Promise<IdeEntry[]>;
  onOpen(path: string): void;
  onError(error: unknown): void;
  selected?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<IdeEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    let live = true;
    setBusy(true);
    void list(entry.path)
      .then((rows) => {
        if (live) setChildren(rows);
      })
      .catch((error) => {
        if (live) {
          onError(error);
        }
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [expanded, entry.path, list, onError]);
  const open = () => (entry.kind === "dir" ? setExpanded((value) => !value) : onOpen(entry.path));
  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-label={basename(entry.path)}
      aria-level={depth + 1}
      aria-expanded={entry.kind === "dir" ? expanded : undefined}
      aria-selected={entry.path === selected}
      aria-busy={busy || undefined}
      className="outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const rows = [
          ...(event.currentTarget
            .closest('[role="tree"]')
            ?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []),
        ];
        const index = rows.indexOf(event.currentTarget);
        if (
          ["Enter", " ", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(
            event.key,
          )
        )
          event.preventDefault();
        if (event.key === "Enter" || event.key === " ") open();
        else if (event.key === "ArrowRight")
          entry.kind === "dir" ? setExpanded(true) : onOpen(entry.path);
        else if (event.key === "ArrowLeft")
          expanded
            ? setExpanded(false)
            : event.currentTarget.parentElement?.closest<HTMLElement>('[role="treeitem"]')?.focus();
        else if (event.key === "ArrowDown") rows[index + 1]?.focus();
        else if (event.key === "ArrowUp") rows[index - 1]?.focus();
        else if (event.key === "Home") rows[0]?.focus();
        else if (event.key === "End") rows.at(-1)?.focus();
      }}
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={open}
        title={entry.path}
        style={{ paddingInlineStart: 8 + depth * 14 }}
        className={`flex w-full items-center gap-1.5 py-1.5 pr-2 text-left hover:bg-accent ${entry.path === selected ? "bg-accent" : ""}`}
      >
        {entry.kind === "dir" ? (
          expanded ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )
        ) : (
          <span className="w-3.5" />
        )}
        {entry.kind === "dir" ? <Folder size={14} /> : <File size={14} />}
        <span className="truncate">{basename(entry.path)}</span>
      </button>
      {expanded && children ? (
        <fieldset className="m-0 min-w-0 border-0 p-0">
          {children.map((child) => (
            <TreeEntry
              key={`${child.kind}:${child.path}`}
              entry={child}
              depth={depth + 1}
              list={list}
              onOpen={onOpen}
              onError={onError}
              selected={selected}
            />
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}
