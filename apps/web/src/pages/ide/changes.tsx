import type { Bot, IdeChange } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { todayRange } from "./model";

export function useChanges(
  rootId: string | undefined,
  bots: Bot[],
  onError: (error: unknown) => void,
  onFilesChanged: () => void,
) {
  const [items, setItems] = useState<IdeChange[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const generation = useRef(0);
  const loadingMore = useRef(false);
  useEffect(() => {
    setItems([]);
    setCursor(null);
  }, [rootId]);
  useEffect(() => {
    if (!rootId) return;
    const abort = new AbortController();
    generation.current++;
    void rpc.ide
      .changes({ rootId, ...todayRange() }, { signal: abort.signal })
      .then((page) => {
        if (abort.signal.aborted) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((error) => {
        if (!abort.signal.aborted) onError(error);
      });
    return () => abort.abort();
  }, [rootId, revision, onError]);
  useEffect(() => {
    const abort = new AbortController();
    const changed = () => {
      onFilesChanged();
      refresh((value) => value + 1);
    };
    // The existing event streams carry invalidations; the IDE never polls the filesystem.
    for (const bot of bots)
      void (async () => {
        const head = await rpc.threads.head({ botId: bot.id }, { signal: abort.signal });
        refresh((value) => value + 1);
        const events = await rpc.threads.subscribe(
          { botId: bot.id, cursor: head.cursor },
          { signal: abort.signal },
        );
        for await (const event of events) {
          if (abort.signal.aborted) return;
          if (
            [
              "computer.file.changed",
              "command.finished",
              "thread.artifact",
              "run.completed",
            ].includes(event.type)
          )
            changed();
        }
      })().catch((error) => {
        if (!abort.signal.aborted) onError(error);
      });
    const visible = () => {
      if (document.visibilityState === "visible") changed();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      abort.abort();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [bots, onError, onFilesChanged]);
  const more = useCallback(async () => {
    if (!rootId || !cursor || loadingMore.current) return;
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
  }, [rootId, cursor]);
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

export function SideBySideDiff({ change }: { change: IdeChange }) {
  const { t } = useLingui();
  const before = change.before?.split("\n"),
    after = change.after?.split("\n");
  const rows = Math.max(before?.length ?? 0, after?.length ?? 0);
  return (
    <div className="h-full overflow-auto" data-testid="ide-diff">
      <div className="grid min-w-max grid-cols-2 text-xs">
        <div className="sticky top-0 border-b border-r border-border bg-card px-3 py-2">{t`Before`}</div>
        <div className="sticky top-0 border-b border-border bg-card px-3 py-2">{t`After`}</div>
        <pre className="border-r border-border py-2">
          {before ? (
            Array.from({ length: rows }, (_, index) => (
              <span
                key={`${index}-${before[index] ?? ""}`}
                className={`block min-h-5 px-3 ${before[index] !== after?.[index] && before[index] !== undefined ? "bg-destructive/10" : ""}`}
              >
                {before[index] ?? " "}
              </span>
            ))
          ) : (
            <span className="px-3 text-muted-foreground">{t`Not recorded`}</span>
          )}
        </pre>
        <pre className="py-2">
          {after ? (
            Array.from({ length: rows }, (_, index) => (
              <span
                key={`${index}-${after[index] ?? ""}`}
                className={`block min-h-5 px-3 ${after[index] !== before?.[index] && after[index] !== undefined ? "bg-success/10" : ""}`}
              >
                {after[index] ?? " "}
              </span>
            ))
          ) : (
            <span className="px-3 text-muted-foreground">{t`Not recorded`}</span>
          )}
        </pre>
      </div>
    </div>
  );
}
