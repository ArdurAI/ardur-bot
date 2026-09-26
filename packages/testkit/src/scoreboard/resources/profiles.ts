import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { SCOREBOARD_MANIFEST } from "../manifest.js";
import { REPLAY_CANCELLATION_MESSAGE } from "../replay/services.js";
import type { ResourceFrame } from "./contracts.js";
import { finite } from "./contracts.js";

export const RESOURCE_PROFILES = {
  "stabilized-idle": {
    stabilizationMs: 60_000,
    durationMs: SCOREBOARD_MANIFEST.samplePlan.stabilizedIdleMinutes * 60_000,
    intervalMs: 1000,
  },
  "quiet-extension": {
    stabilizationMs: 60_000,
    durationMs: SCOREBOARD_MANIFEST.samplePlan.quietIntervalMinutes * 60_000,
    intervalMs: 1000,
  },
  "mixed-soak": {
    stabilizationMs: 60_000,
    durationMs: SCOREBOARD_MANIFEST.samplePlan.mixedSoakMinutes * 60_000,
    intervalMs: 1000,
  },
} as const;
export type ResourceProfile = keyof typeof RESOURCE_PROFILES;
export interface SampleAttempt {
  scheduledMs: number;
  atMs: number;
  frame: ResourceFrame | null;
  status: "measured" | "failed" | "missed";
}

/** True when the rejection is the collector abort the workload just observed. */
function causedByCollectorAbort(signal: AbortSignal, error: unknown): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason) return true;
  return (
    error instanceof Error &&
    error.cause === signal.reason &&
    (error.name === "AbortError" || error.message === REPLAY_CANCELLATION_MESSAGE)
  );
}

/** Absolute scheduling retains missed slots; a slow sampler never overlaps itself or hides load. */
export async function collectResourceProfile(options: {
  profile: ResourceProfile;
  sample: (signal: AbortSignal) => Promise<ResourceFrame>;
  signal: AbortSignal;
  onAttempt: (attempt: SampleAttempt) => Promise<void>;
  mixedWork?: (signal: AbortSignal) => Promise<void>;
  clock?: { now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void> };
}) {
  const spec = RESOURCE_PROFILES[options.profile];
  if (!spec) throw new Error("Unknown resource profile");
  if (options.profile === "mixed-soak" && !options.mixedWork)
    throw new Error("Mixed soak requires a declared workload");
  const clock = options.clock ?? {
    now: () => performance.now(),
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
  };
  await clock.sleep(spec.stabilizationMs, options.signal).catch((error) => {
    if (!options.signal.aborted) throw error;
  });
  const start = clock.now();
  const workload = new AbortController();
  const workSignal = AbortSignal.any([options.signal, workload.signal]);
  let work: Promise<void> | undefined;
  let workRunning = false;
  let workloadFailures = 0;
  let collectorStopped = false;
  let failures = 0,
    missed = 0,
    attempts = 0;
  try {
    for (let scheduledMs = 0; scheduledMs <= spec.durationMs; scheduledMs += spec.intervalMs) {
      if (options.signal.aborted) break;
      const wait = start + scheduledMs - clock.now();
      if (wait > 0)
        await clock.sleep(wait, options.signal).catch((error) => {
          if (!options.signal.aborted) throw error;
        });
      if (options.signal.aborted) break;
      if (options.mixedWork && !workRunning && scheduledMs < spec.durationMs) {
        workRunning = true;
        work = options
          .mixedWork(workSignal)
          .catch((error: unknown) => {
            // Ending the window aborts leftover work. That cancellation is not a failed sample.
            if (
              collectorStopped &&
              !options.signal.aborted &&
              causedByCollectorAbort(workSignal, error)
            )
              return;
            workloadFailures++;
          })
          .finally(() => {
            workRunning = false;
          });
      }
      const atMs = clock.now() - start;
      finite(atMs);
      let frame: ResourceFrame | null = null;
      let status: SampleAttempt["status"] = "measured";
      if (atMs - scheduledMs >= spec.intervalMs) {
        status = "missed";
        missed++;
      } else {
        try {
          frame = await options.sample(options.signal);
        } catch {
          status = "failed";
          failures++;
        }
      }
      await options.onAttempt({ scheduledMs, atMs, frame, status });
      attempts++;
    }
  } finally {
    collectorStopped = !options.signal.aborted;
    workload.abort();
    await work;
  }
  const expected = spec.durationMs / spec.intervalMs + 1;
  return {
    profile: options.profile,
    ...spec,
    expected,
    attempts,
    failures,
    missed,
    workloadFailures,
    elapsedMs: clock.now() - start,
    complete:
      attempts === expected &&
      failures === 0 &&
      missed === 0 &&
      workloadFailures === 0 &&
      !options.signal.aborted,
  };
}
