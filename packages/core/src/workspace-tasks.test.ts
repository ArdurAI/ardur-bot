import type { WorkspaceTasks } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  workspaceSteerThread,
  workspaceStopStillPending,
  workspaceStopTarget,
  workspaceTaskBuckets,
} from "./workspace-tasks.js";

function run(id: string, botId: string, status: string) {
  return {
    runId: id,
    botId,
    status,
    threadId: `${id}-thread`,
    coordinatorThreadId: botId === "helper" ? "coordinator-thread" : null,
    rootTaskId: botId === "helper" ? "root" : undefined,
  } as WorkspaceTasks["runs"][number];
}

describe("workspace task targets", () => {
  it("keeps queued runs separate from scheduled routines and routes delegated actions to the root", () => {
    const own = run("own", "bot", "running");
    const queued = run("queued", "bot", "queued");
    const helper = run("helper", "helper", "running");
    const snapshot = {
      runs: [own, queued, helper],
      delegations: [{ id: "waiting", runId: null }],
      routines: [{ id: "tomorrow", name: "Tomorrow", nextRunAt: "2026-09-29T00:00:00Z" }],
    } as WorkspaceTasks;
    const buckets = workspaceTaskBuckets(snapshot, "bot");
    expect(buckets.running).toEqual([own]);
    expect(buckets.queued).toEqual([queued]);
    expect(buckets.delegatedRuns).toEqual([helper]);
    expect(buckets.delegations).toHaveLength(1);
    expect(workspaceStopTarget(own, "bot")).toEqual({ kind: "thread", id: "own-thread" });
    expect(workspaceStopTarget(helper, "bot")).toEqual({ kind: "delegation", id: "root" });
    expect(workspaceSteerThread(helper, "bot")).toBe("coordinator-thread");
    expect(workspaceStopTarget({ ...helper, rootTaskId: undefined }, "bot")).toBeNull();
    expect(workspaceSteerThread({ ...helper, coordinatorThreadId: null }, "bot")).toBeNull();
    expect(workspaceStopStillPending(snapshot, "helper")).toBe(true);
    expect(
      workspaceStopStillPending(
        { ...snapshot, runs: [{ ...helper, status: "cancelled" }] },
        "helper",
      ),
    ).toBe(false);
  });
});
