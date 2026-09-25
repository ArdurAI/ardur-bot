import type { TeamRow } from "@ardurbot/contracts";
import { useEffect, useRef } from "react";
import { rpc } from "../../lib/rpc";

/** Same thread events and roster repair cadence as TeamBoard. */
export function useThreadRefresh(rows: TeamRow[], refresh: () => Promise<void>) {
  const latest = useRef(rows);
  latest.current = rows;
  const subscriptions = rows
    .filter((row) => row.threadId)
    .map((row) => row.botId)
    .sort()
    .join(",");
  useEffect(() => {
    const abort = new AbortController();
    for (const botId of subscriptions.split(",")) {
      const row = latest.current.find((item) => item.botId === botId);
      if (!row?.threadId) continue;
      void (async () => {
        try {
          const events = await rpc.threads.subscribe(
            { botId: row.botId, cursor: row.cursor },
            { signal: abort.signal },
          );
          for await (const _event of events) {
            if (abort.signal.aborted) break;
            void refresh();
          }
        } catch {
          /* Foreground polling repairs unavailable streams. */
        }
      })();
    }
    return () => abort.abort();
  }, [subscriptions, refresh]);
}
