import type { AgentRuntime } from "@ardurbot/adapter-kit";
import { RuntimePinError } from "@ardurbot/contracts/runtime-pins";
import type { TurnProgress } from "./turn-progress.js";
import { resumedTurnHistory } from "./turn-progress.js";

const RETRY_WAITS_MS = [20_000, 40_000, 60_000] as const;

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Retry only a lost Codex transport with saved progress, on the original pin. */
export function withRuntimeRecovery(
  invoke: AgentRuntime["run"],
  progress: TurnProgress,
  save: () => Promise<void>,
  onRetry: (retry: number, waitMs: number, error: RuntimePinError) => void,
): AgentRuntime["run"] {
  return async function* (request, context) {
    let current = request;
    let retries = 0;
    for (;;) {
      context?.signal?.throwIfAborted();
      try {
        yield* invoke(current, context);
        return;
      } catch (error) {
        const snapshot = progress.snapshot();
        const progressed =
          snapshot.effects.length > 0 ||
          (Array.isArray(snapshot.runtimeState) && snapshot.runtimeState.length > 0);
        if (
          !(error instanceof RuntimePinError) ||
          request.model.runtimePin?.runtimeKind !== "codex-app-server" ||
          !error.problem.failure?.retryable ||
          !progressed ||
          context?.signal?.aborted
        )
          throw error;
        error.problem.failure.retries = retries;
        const waitMs = RETRY_WAITS_MS[retries];
        if (waitMs === undefined) throw error;
        // The failed generator has closed its process and drained admitted effects.
        // Persist their latest receipts before a replacement process can call tools.
        await save();
        progress.recoverEffects();
        current = {
          ...request,
          nativeSession: undefined,
          prompt: snapshot.prompt,
          history: resumedTurnHistory(snapshot),
          stableHistory: undefined,
          restartState: snapshot.runtimeState,
          priorToolCalls: snapshot.effects.length,
        };
        onRetry(++retries, waitMs, error);
        await waitForRetry(waitMs, context?.signal);
      }
    }
  };
}
