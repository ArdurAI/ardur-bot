import type { ConnectorCall } from "@ardurbot/adapter-kit";
import type { ChiefActivity, ChiefActivityKey } from "@ardurbot/contracts";
import { CHIEF_TOOL_STALE_MS, chiefToolActivity, chiefToolCapability } from "@ardurbot/core";

/** Owns only this attempt's timer; the writer persists a scoped safe snapshot. */
export function chiefActivityFeed(input: {
  revision: number;
  runId: string;
  delegationId: string;
  attempt: number;
  write: (activity: ChiefActivity) => Promise<unknown>;
}) {
  let sourceSeq = 0;
  let latestKey: ChiefActivityKey = "working";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let pending = Promise.resolve();
  const seen = new Set<string>();
  const active = new Map<string, ChiefActivityKey>();
  const emit = (key: ChiefActivityKey, state: ChiefActivity["state"], executionId?: string) => {
    const activity: ChiefActivity = {
      revision: input.revision,
      runId: input.runId,
      delegationId: input.delegationId,
      attempt: input.attempt,
      sourceSeq: ++sourceSeq,
      key,
      state,
      updatedAt: new Date().toISOString(),
      ...(executionId ? { executionId } : {}),
    };
    pending = pending.then(async () => {
      // Observational projection must never fail a tool or poison later settlement.
      await input.write(activity).catch(() => undefined);
    });
    return pending;
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const waitForLatest = () => {
    clear();
    const latest = [...active].at(-1);
    if (!latest) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed && active.has(latest[0])) void emit("waiting-tool", "active", latest[0]);
    }, CHIEF_TOOL_STALE_MS);
    timer.unref?.();
  };
  const start = async (executionId: string, key: ChiefActivityKey) => {
    if (closed || seen.has(executionId)) return;
    seen.add(executionId);
    active.set(executionId, key);
    latestKey = key;
    waitForLatest();
    await emit(key, "active", executionId);
  };
  return {
    start,
    startTool: async (call: ConnectorCall) => {
      const identity = {
        name: call.route?.toolName ?? call.tool,
        serviceId: call.route?.serviceId,
      };
      await start(
        call.executionId,
        chiefToolActivity({ ...identity, capability: chiefToolCapability(identity) }),
      );
    },
    finish: async (executionId: string) => {
      if (closed || !active.delete(executionId)) return;
      const latest = [...active].at(-1);
      waitForLatest();
      // Retain the last genuine action between calls; do not invent a new action.
      await emit(latest?.[1] ?? latestKey, latest ? "active" : "idle", latest?.[0] ?? executionId);
    },
    settle: async (state: ChiefActivity["state"]) => {
      if (closed) return;
      closed = true;
      clear();
      await emit(latestKey, state);
    },
  };
}
