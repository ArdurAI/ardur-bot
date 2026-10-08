import { expect, it } from "vitest";
import { reduceRestartState } from "./restart-state.js";

it("marks only the suspended run, clears it on resume, and ignores stale events", () => {
  const run = { id: "run", restarting: false };
  const snapshot = {
    cursor: 1,
    run,
    contextRun: run,
    activeRuns: [run, { id: "other", restarting: false }],
  };
  const suspended = reduceRestartState(snapshot, { type: "run.suspended", runId: "run", seq: 2 });
  expect(suspended.run.restarting).toBe(true);
  expect(suspended.activeRuns[1]?.restarting).toBe(false);
  const resumed = reduceRestartState(suspended, { type: "run.resumed", runId: "run", seq: 3 });
  expect(resumed.run.restarting).toBe(false);
  expect(reduceRestartState(resumed, { type: "run.suspended", runId: "run", seq: 2 })).toBe(
    resumed,
  );
});
