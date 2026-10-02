import type { IdeChange, WorkspaceContext, WorkspaceRootBinding } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Changes, useChanges } from "../ide/changes";
import type { ChangeLocation } from "./change-target";
import { readWorkspaceChange } from "./change-target";
import { todayRange } from "./files-model";

const Diff = lazy(() => import("../ide/diff"));
const unchanged = () => {};

export function WorkspaceChanges({
  context,
  visible,
  location,
}: {
  context: WorkspaceContext;
  visible: boolean;
  location?: ChangeLocation;
}) {
  const { t } = useLingui();
  const [selected, setSelected] = useState<IdeChange | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const onError = useCallback(() => setError(true), []);
  const target = useMemo<WorkspaceRootBinding | undefined>(
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
  const history = useChanges(context.rootId, visible && !!target, onError, unchanged, target);
  const open = useCallback(
    async (location: Omit<ChangeLocation, "requestId">) => {
      if (!target) return;
      request.current?.abort();
      const abort = new AbortController();
      request.current = abort;
      setSelected(null);
      setError(false);
      setLoading(true);
      try {
        const change = await readWorkspaceChange(target, location, abort.signal);
        if (!abort.signal.aborted) setSelected(change);
      } catch {
        if (!abort.signal.aborted) setError(true);
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    },
    [target],
  );
  useEffect(() => {
    setSelected(null);
    setLoading(false);
    setError(false);
    if (location) void open(location);
    return () => request.current?.abort();
  }, [location, open]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-workspace-changes>
      {error ? (
        <p role="alert" className="p-2 text-xs text-destructive">{t`Could not open file`}</p>
      ) : null}
      {loading ? (
        <p role="status" className="p-2 text-xs text-muted-foreground">{t`Loading…`}</p>
      ) : selected ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(null)}
          >{t`Recorded changes`}</Button>
          <div className="px-2 py-1 font-mono text-xs text-muted-foreground">{selected.path}</div>
          <div className="min-h-0 flex-1 overflow-auto">
            <Suspense fallback={null}>
              <Diff change={selected} />
            </Suspense>
          </div>
        </>
      ) : (
        <>
          {!history.items.length && !history.more && !error ? (
            <p className="p-4 text-sm text-muted-foreground">{t`No changes to show`}</p>
          ) : null}
          <Changes
            label={t`Recorded changes`}
            items={history.items}
            more={history.more}
            onOpen={(change) =>
              void open({ changeId: change.id, ...todayRange(new Date(change.createdAt)) })
            }
            onError={onError}
          />
        </>
      )}
    </div>
  );
}
