import type { IdeChange } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { todayRange } from "./model";

type ChangeHistory = {
  items: IdeChange[];
  retained: IdeChange[];
  cursor: string | null;
  headCursor?: string | null;
};

export function useChanges(
  rootId: string | undefined,
  enabled: boolean,
  onError: (error: unknown) => void,
  onFilesChanged: () => void,
) {
  const history = useRef<ChangeHistory>({ items: [], retained: [], cursor: null });
  const [state, setState] = useState(history.current);
  const generation = useRef(0);
  const loadingMore = useRef(false);
  const day = useRef(todayRange().since);
  useEffect(() => {
    history.current = { items: [], retained: [], cursor: null };
    setState(history.current);
    loadingMore.current = false;
    day.current = todayRange().since;
  }, [rootId]);
  useEffect(() => {
    if (!rootId) return;
    // Commands and completed runs can change files without producing a recorded diff.
    const refresh = () => {
      if (document.visibilityState === "visible") onFilesChanged();
    };
    const timer = setInterval(refresh, 10_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [rootId, onFilesChanged]);
  useEffect(() => {
    if (!rootId || !enabled) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    const refresh = async () => {
      if (pending || abort.signal.aborted || document.visibilityState !== "visible") return;
      clearTimeout(timer);
      pending = true;
      const range = todayRange();
      if (day.current !== range.since) {
        generation.current++;
        day.current = range.since;
        loadingMore.current = false;
        history.current = { items: [], retained: [], cursor: null };
        setState(history.current);
      }
      try {
        const page = await rpc.ide.changes({ rootId, ...range }, { signal: abort.signal });
        if (abort.signal.aborted) return;
        const previous = history.current;
        const ids = new Set(previous.items.map((item) => item.id));
        const continuous =
          previous.headCursor !== undefined &&
          (page.nextCursor === previous.headCursor || page.items.some((item) => ids.has(item.id)));
        if (!continuous) {
          generation.current++;
          loadingMore.current = false;
        }
        // Retain older rows for display, but page through a disjoint head's missing interval first.
        history.current = {
          items: continuous ? mergeChanges(page.items, previous.items) : page.items,
          retained: continuous
            ? previous.retained
            : mergeChanges(previous.items, previous.retained),
          cursor: continuous ? previous.cursor : page.nextCursor,
          headCursor: page.nextCursor,
        };
        setState(history.current);
      } catch (error) {
        if (!abort.signal.aborted) onError(error);
      } finally {
        pending = false;
        if (!abort.signal.aborted && document.visibilityState === "visible")
          timer = setTimeout(() => void refresh(), 10_000);
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    document.addEventListener("visibilitychange", visible);
    return () => {
      generation.current++;
      loadingMore.current = false;
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [rootId, enabled, onError]);
  const more = useCallback(async () => {
    const cursor = history.current.cursor;
    if (!enabled || !rootId || !cursor || loadingMore.current) return;
    const range = todayRange();
    if (range.since !== day.current) return;
    loadingMore.current = true;
    const request = generation.current;
    try {
      const page = await rpc.ide.changes({ rootId, ...range, cursor });
      if (request !== generation.current) return;
      history.current = {
        ...history.current,
        items: mergeChanges(history.current.items, page.items),
        cursor: page.nextCursor,
      };
      setState(history.current);
    } finally {
      if (request === generation.current) loadingMore.current = false;
    }
  }, [rootId, enabled]);
  return {
    items: mergeChanges(state.items, state.retained),
    more: state.cursor ? more : undefined,
  };
}

function mergeChanges(first: IdeChange[], rest: IdeChange[]) {
  const ids = new Set(first.map((item) => item.id));
  return [...first, ...rest.filter((item) => !ids.has(item.id))];
}

export function Changes({
  items,
  more,
  onOpen,
  onError,
}: {
  items: IdeChange[];
  more?: () => Promise<void>;
  onOpen(change: IdeChange): void;
  onError(error: unknown): void;
}) {
  const { t } = useLingui();
  return (
    <section className="h-full overflow-auto p-2" aria-label={t`Changes`}>
      {items.map((change) => (
        <Button
          variant="ghost"
          key={change.id}
          className="flex w-full justify-start font-mono text-xs"
          onClick={() => onOpen(change)}
        >
          {change.path}
        </Button>
      ))}
      {more ? (
        <Button variant="ghost" onClick={() => void more().catch(onError)}>{t`Load more`}</Button>
      ) : null}
    </section>
  );
}
