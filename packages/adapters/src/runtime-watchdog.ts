import type { AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { beforeDeadline, StepDeadlineExceeded } from "@ardurbot/core";
import { getLogger } from "@ardurbot/logging";
import { MODEL_STREAM_TIMEOUT_MS } from "./pi-runtime-limits.js";
import { RESTART_DRAIN_MS } from "./restart-drain.js";

/** Runtime events and owned tools, not lease renewal, are activity. */
export function createRuntimeWatchdog(controller: AbortController, shutdownSignal?: AbortSignal) {
  let lastActivityAt = Date.now();
  let tools = 0;
  let timedOut = false;
  let finishedAt: number | undefined;
  const deadline = () =>
    finishedAt === undefined
      ? lastActivityAt + MODEL_STREAM_TIMEOUT_MS
      : finishedAt + RESTART_DRAIN_MS;
  const touch = () => {
    lastActivityAt = Date.now();
  };
  return {
    touch,
    finished() {
      finishedAt ??= Date.now();
    },
    beginTool() {
      tools++;
      touch();
      return () => {
        tools--;
        touch();
      };
    },
    async next<T>(work: () => Promise<T>): Promise<T> {
      let pending: Promise<T> | undefined;
      while (true) {
        try {
          return await beforeDeadline(
            "runtime",
            deadline(),
            () => (pending ??= work()),
            shutdownSignal,
          );
        } catch (error) {
          if (!(error instanceof StepDeadlineExceeded)) {
            if (shutdownSignal?.aborted) timedOut = true;
            throw error;
          }
          // A long-running tool has its own execution deadline. Do not mistake it
          // for a quiet model, or fail solely because a heartbeat renewed a lease.
          if (finishedAt === undefined && (tools > 0 || Date.now() < deadline())) {
            touch();
            continue;
          }
          timedOut = true;
          controller.abort(error);
          getLogger().warn("run.step.timed_out", { step: error.step });
          throw error;
        }
      }
    },
    async close(work: () => Promise<unknown>) {
      if (!timedOut && !(controller.signal.reason instanceof StepDeadlineExceeded)) {
        try {
          return await beforeDeadline(
            "runtime-close",
            Date.now() + RESTART_DRAIN_MS,
            work,
            shutdownSignal,
          );
        } catch (error) {
          if (!(error instanceof StepDeadlineExceeded) && !shutdownSignal?.aborted) throw error;
          if (error instanceof StepDeadlineExceeded)
            getLogger().warn("run.step.timed_out", { step: error.step });
          return;
        }
      }
      // A stuck iterator can ignore abort and queue return behind next forever.
      // It cannot keep an already-failed run in the active registry.
      void work().catch(() => undefined);
    },
  };
}

/** Bound the stream's quiet waits without changing its events or usage accounting. */
export function watchRuntimeActivity(
  events: AsyncIterable<AgentRuntimeEvent>,
  watchdog: ReturnType<typeof createRuntimeWatchdog>,
): AsyncIterable<AgentRuntimeEvent> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = events[Symbol.asyncIterator]();
      return {
        async next() {
          const next = await watchdog.next(() => iterator.next());
          if (!next.done) {
            watchdog.touch();
            if (next.value.type === "done") watchdog.finished();
          }
          return next;
        },
        async return() {
          await watchdog.close(async () => {
            await iterator.return?.();
          });
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}
