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
  useEffect(() => {
    setItems([]);
    setCursor(null);
  }, [rootId]);
  useEffect(() => {
    if (!rootId || !enabled) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    let signature: string | undefined;
    const refresh = async () => {
      if (pending || abort.signal.aborted || document.visibilityState !== "visible") return;
      clearTimeout(timer);
      pending = true;
      generation.current++;
      try {
        const page = await rpc.ide.changes({ rootId, ...todayRange() }, { signal: abort.signal });
        if (abort.signal.aborted) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        const next = JSON.stringify(page.items.map((item) => item.id));
        if (signature !== next) onFilesChanged();
        signature = next;
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
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [rootId, enabled, onError, onFilesChanged]);
  const more = useCallback(async () => {
    if (!enabled || !rootId || !cursor || loadingMore.current) return;
    loadingMore.current = true;
    const request = generation.current;
    try {
      const page = await rpc.ide.changes({ rootId, ...todayRange(), cursor });
      if (request !== generation.current) return;
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      loadingMore.current = false;
    }
  }, [rootId, cursor, enabled]);
  return { items, more: cursor ? more : undefined };
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
