import type { ThreadSnapshot } from "@ardurbot/contracts";
import type { SealPhase, SealPhaseState } from "@ardurbot/core";
import { deriveSealPhase, sealActivity } from "@ardurbot/core";
import { useEffect, useMemo, useState } from "react";
import { activeMemberRun, activeThreadRuns } from "./thread-events";

export interface ThreadSealInput {
  /** When each bot's latest run completed, in local epoch ms, from this session's events. */
  completedAt: ReadonlyMap<string, number>;
  /** Failed runs whose error the reader has dismissed. */
  seenErrors: ReadonlySet<string>;
  now: number;
}

/**
 * Seal phases for the bots whose runs the open thread shows: its active runs
 * with their live work record, its failed run and recent completions. Bots at
 * rest are left out so the bot list can speak for runs elsewhere.
 */
export function threadSealPhases(
  snapshot: ThreadSnapshot | null,
  input: ThreadSealInput,
): Map<string, SealPhaseState> {
  const phases = new Map<string, SealPhaseState>();
  const keep = (botId: string, state: SealPhaseState) => {
    if (state.phase !== "idle" && !phases.has(botId)) phases.set(botId, state);
  };
  const runs = snapshot ? activeThreadRuns(snapshot) : [];
  for (const botId of new Set(runs.map((run) => run.botId))) {
    const run = activeMemberRun(runs, botId);
    if (!run || !snapshot) continue;
    keep(
      botId,
      deriveSealPhase({
        status: run.status,
        startedAt: run.startedAt ? Date.parse(run.startedAt) : null,
        activity: sealActivity(snapshot.messages, run.id),
        now: input.now,
      }),
    );
  }
  const failed = snapshot?.run?.status === "failed" ? snapshot.run : null;
  if (failed) {
    keep(
      failed.botId,
      deriveSealPhase({ status: "failed", errorSeen: input.seenErrors.has(failed.id) }),
    );
  }
  for (const [botId, endedAt] of input.completedAt) {
    keep(botId, deriveSealPhase({ status: "completed", endedAt, now: input.now }));
  }
  return phases;
}

/**
 * A bot's phase from the open thread and the bot list. The thread knows its own
 * runs best; the list's status covers runs elsewhere, and a newer run anywhere
 * ends an error.
 */
export function botSealPhase(thread: SealPhaseState | undefined, listStatus?: string): SealPhase {
  const listed = deriveSealPhase({ status: listStatus }).phase;
  if (!thread || (thread.phase === "error" && listed !== "idle")) return listed;
  return thread.phase;
}

/** {@link threadSealPhases}, derived again when a timed phase such as `done` ends. */
export function useThreadSealPhases(
  snapshot: ThreadSnapshot | null,
  completedAt: ReadonlyMap<string, number>,
  seenErrors: ReadonlySet<string>,
): ReadonlyMap<string, SealPhaseState> {
  const [tick, setTick] = useState(0);
  // `tick` changes when a timed phase ends, so the phases are derived again then.
  const phases = useMemo(
    () => threadSealPhases(snapshot, { completedAt, seenErrors, now: Date.now() }),
    [snapshot, completedAt, seenErrors, tick],
  );
  const until = Math.min(...[...phases.values()].flatMap((state) => state.until ?? []));
  useEffect(() => {
    if (!Number.isFinite(until)) return;
    const timer = window.setTimeout(() => setTick((value) => value + 1), until - Date.now());
    return () => window.clearTimeout(timer);
  }, [until, tick]);
  return phases;
}
