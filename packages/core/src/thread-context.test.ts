import { ContextSnapshotSchema } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { reduceRunContext } from "./thread-context.js";

it("updates only the matching run from measured context and rejects stale or invalid events", () => {
  const snapshot = { cursor: 2, run: { id: "run" }, activeRuns: [{ id: "run" }, { id: "peer" }] };
  const payload = ContextSnapshotSchema.parse({
    layers: { stable: 500, brief: 100, summary: 0, messages: 0, recall: 0, message: 20 },
    recallRan: false,
    recallCalls: 0,
    cachedTokens: null,
    inputTokens: null,
    timeToFirstTokenMs: 12,
    queueWaitMs: 8,
    routingRule: "default",
  });
  const updated = reduceRunContext(snapshot, { runId: "run", seq: 3, payload });
  expect(updated.run).toMatchObject({ contextSnapshot: payload, routingRule: "default" });
  expect(updated.activeRuns[1]).toBe(snapshot.activeRuns[1]);
  expect(reduceRunContext(updated, { runId: "run", seq: 2, payload })).toBe(updated);
  expect(reduceRunContext(updated, { runId: "run", seq: 4, payload: {} })).toBe(updated);
});
