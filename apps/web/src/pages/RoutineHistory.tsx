import type { RoutineRun } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { statusLabel } from "../lib/run-status-label";

export function RoutineHistory({ routineId, running }: { routineId: string; running: boolean }) {
  const { i18n } = useLingui();
  const [attempts, setAttempts] = useState<RoutineRun[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setAttempts(null);
    setFailed(false);
    const load = async () => {
      try {
        const rows = await rpc.routines.history({ routineId });
        if (!live) return;
        setAttempts(rows);
        if (
          running ||
          rows.some((row) => !["failed", "completed", "cancelled"].includes(row.status))
        )
          timer = setTimeout(() => void load(), 5000);
      } catch {
        if (live) setFailed(true);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [routineId, running, retry]);
  if (failed)
    return (
      <div role="alert">
        <Trans>Could not load run history.</Trans>{" "}
        <Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    );
  if (!attempts)
    return (
      <p>
        <Trans>Loading…</Trans>
      </p>
    );
  if (!attempts.length)
    return (
      <p>
        <Trans>No runs yet</Trans>
      </p>
    );
  return (
    <ul className="mt-2 space-y-2">
      {attempts.map((attempt) => (
        <li key={attempt.id} className="flex flex-wrap justify-between gap-2">
          <span>{statusLabel(attempt.status)}</span>
          <time dateTime={attempt.completedAt ?? attempt.createdAt}>
            {new Date(attempt.completedAt ?? attempt.createdAt).toLocaleString(i18n.locale || "en")}
          </time>
        </li>
      ))}
    </ul>
  );
}
