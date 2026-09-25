import type { IdeChange } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { todayRange } from "./model";

export function useChanges(
  rootId: string | undefined,
  enabled: boolean,
  onError: (error: unknown) => void,
  onFilesChanged: () => void,
) {
  const [items, setItems] = useState<IdeChange[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const generation = useRef(0);
  const loadingMore = useRef(false);
  const loadedMore = useRef(false);
  const day = useRef(todayRange().since);
  useEffect(() => {
    setItems([]);
    setCursor(null);
    loadedMore.current = false;
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
        loadedMore.current = false;
        loadingMore.current = false;
        setItems([]);
        setCursor(null);
      }
      try {
        const page = await rpc.ide.changes({ rootId, ...range }, { signal: abort.signal });
        if (abort.signal.aborted) return;
        setItems((current) => mergeChanges(page.items, current));
        if (!loadedMore.current) setCursor(page.nextCursor);
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
    if (!enabled || !rootId || !cursor || loadingMore.current) return;
    const range = todayRange();
    if (range.since !== day.current) return;
    loadingMore.current = true;
    loadedMore.current = true;
    const request = generation.current;
    try {
      const page = await rpc.ide.changes({ rootId, ...range, cursor });
      if (request !== generation.current) return;
      setItems((current) => mergeChanges(current, page.items));
      setCursor(page.nextCursor);
    } finally {
      if (request === generation.current) loadingMore.current = false;
    }
  }, [rootId, cursor, enabled]);
  return { items, more: cursor ? more : undefined };
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
