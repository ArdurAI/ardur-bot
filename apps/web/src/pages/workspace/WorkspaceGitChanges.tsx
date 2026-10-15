import type { GitStatusEntry, WorkspaceContext } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";

const Diff = lazy(() => import("../ide/diff"));

type LoadState = "loading" | "error" | "ready";
type ObservationStatus = "ok" | "not-repository" | "unavailable";
type FileDiff = {
  before: string | null;
  after: string | null;
  binary: boolean;
  truncated: boolean;
};

/** The bot's real worktree changes, observed read-only from the Git repository. */
export function WorkspaceGitChanges({
  context,
  visible,
}: {
  context: WorkspaceContext;
  visible: boolean;
}) {
  const { t } = useLingui();
  const [status, setStatus] = useState<ObservationStatus | null>(null);
  const [entries, setEntries] = useState<GitStatusEntry[]>([]);
  const [limited, setLimited] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffState, setDiffState] = useState<LoadState>("loading");
  const listRequest = useRef<AbortController | null>(null);
  const diffRequest = useRef<AbortController | null>(null);
  const target = useMemo(
    () =>
      context.rootId && context.computerId && context.generation !== null
        ? {
            botId: context.botId,
            rootId: context.rootId,
            computerId: context.computerId,
            generation: context.generation,
          }
        : undefined,
    [context.botId, context.rootId, context.computerId, context.generation],
  );
  const targetKey = JSON.stringify(target);

  const load = useCallback(async () => {
    if (!target) return;
    listRequest.current?.abort();
    const abort = new AbortController();
    listRequest.current = abort;
    setStatus(null);
    setSelected(null);
    setDiff(null);
    try {
      const result = await rpc.workspace.git(target, { signal: abort.signal });
      if (abort.signal.aborted) return;
      setStatus(result.status);
      setEntries(result.entries ?? []);
      setLimited(result.truncated ?? false);
    } catch {
      if (!abort.signal.aborted) setStatus("unavailable");
    }
  }, [target, targetKey]);

  useEffect(() => {
    if (visible) void load();
    return () => listRequest.current?.abort();
  }, [visible, load]);

  const open = useCallback(
    async (path: string) => {
      if (!target) return;
      diffRequest.current?.abort();
      const abort = new AbortController();
      diffRequest.current = abort;
      setSelected(path);
      setDiffState("loading");
      try {
        const result = await rpc.workspace.git({ ...target, path }, { signal: abort.signal });
        if (abort.signal.aborted) return;
        if (result.status !== "ok" || !result.diff) throw new Error("unavailable");
        setDiff(result.diff);
        setDiffState("ready");
      } catch {
        if (!abort.signal.aborted) {
          setDiff(null);
          setDiffState("error");
        }
      }
    },
    [target, targetKey],
  );

  const groups: [string, GitStatusEntry[]][] = [
    [t`Staged`, entries.filter((entry) => entry.staged)],
    [t`Unstaged`, entries.filter((entry) => entry.unstaged)],
    [t`Untracked`, entries.filter((entry) => entry.untracked)],
  ];
  return (
    <div className="flex h-full min-h-0 flex-col" data-workspace-git>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        {selected ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelected(null);
              setDiff(null);
            }}
          >{t`Git changes`}</Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => void load()}
        >{t`Refresh`}</Button>
      </div>
      {selected ? (
        <>
          <div className="px-2 py-1 font-mono text-xs text-muted-foreground">{selected}</div>
          {diffState === "loading" ? (
            <p role="status" className="p-2 text-xs text-muted-foreground">{t`Loading…`}</p>
          ) : diffState === "error" ? (
            <p role="alert" className="p-2 text-xs text-destructive">{t`Could not open file`}</p>
          ) : (
            <>
              {diff?.binary ? (
                <p className="p-4 text-sm text-muted-foreground">{t`Binary file`}</p>
              ) : null}
              {!diff?.binary && diff?.truncated ? (
                <p className="px-4 pt-4 text-sm text-muted-foreground">{t`Diff is too large`}</p>
              ) : null}
              {diff?.binary ? null : (
                <div className="min-h-0 flex-1 overflow-auto">
                  <Suspense fallback={null}>
                    <Diff change={{ before: diff?.before ?? null, after: diff?.after ?? null }} />
                  </Suspense>
                </div>
              )}
            </>
          )}
        </>
      ) : status === null ? (
        <p role="status" className="p-2 text-xs text-muted-foreground">{t`Loading…`}</p>
      ) : status === "unavailable" ? (
        <p role="alert" className="p-2 text-xs text-destructive">
          {t`Git changes are unavailable on this computer.`}
        </p>
      ) : status === "not-repository" ? (
        <p className="p-4 text-sm text-muted-foreground">{t`Not a Git repository`}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {!entries.length && !limited ? (
            <p className="p-4 text-sm text-muted-foreground">{t`No changes to show`}</p>
          ) : null}
          {groups.map(([label, items]) =>
            items.length ? (
              <div key={label}>
                <div className="px-2 pt-2 text-xs font-medium text-muted-foreground">{label}</div>
                {items.map((entry) => (
                  <button
                    key={`${label}:${entry.path}`}
                    type="button"
                    className="block w-full truncate px-2 py-1 text-left font-mono text-xs hover:bg-muted"
                    onClick={() => void open(entry.path)}
                  >
                    {entry.path}
                  </button>
                ))}
              </div>
            ) : null,
          )}
          {limited ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">{t`Some changes are not shown`}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
