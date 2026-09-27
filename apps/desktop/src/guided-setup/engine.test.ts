import { describe, expect, it, vi } from "vitest";
import type { SetupContext, SetupStep } from "./engine.js";
import { SetupEngine } from "./engine.js";
import type { JournalFileBoundary, StepReceipt } from "./store.js";
import { SetupJournalStore } from "./store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function memoryStore() {
  let raw: string | null = null;
  let rejectWrite: ((value: string) => boolean) | null = null;
  const files: JournalFileBoundary = {
    read: async () => raw,
    write: async (_, value) => {
      if (rejectWrite?.(value)) throw new Error("write failed");
      raw = value;
    },
    exists: async () => raw !== null,
    ensure: async () => undefined,
  };
  return {
    store: new SetupJournalStore("/fixture/data", files),
    raw: () => raw,
    setRaw: (value: string | null) => {
      raw = value;
    },
    reject: (predicate: ((value: string) => boolean) | null) => {
      rejectWrite = predicate;
    },
  };
}
function step(overrides: Partial<SetupStep> = {}): SetupStep {
  return {
    id: "prerequisites",
    revision: 1,
    requires: [],
    canSkip: false,
    check: async () => ({ kind: "needed", reasonCode: "needs-check" }),
    run: async () => ({ kind: "verified", proof: "checked" }),
    verify: async () => ({ kind: "satisfied", checkedAt: 100, evidence: "checked" }),
    cancel: async () => undefined,
    ...overrides,
  };
}
const clock = { monotonic: () => 10, wall: () => 100 };

describe("SetupEngine", () => {
  it("requires fresh checks before handing a saved pilot to local services", async () => {
    const files = memoryStore();
    const satisfied = async () => ({
      kind: "satisfied" as const,
      checkedAt: 100,
      evidence: "ready",
    });
    const steps = [
      step({ id: "prerequisites", check: satisfied }),
      step({ id: "database", requires: ["prerequisites"], check: satisfied }),
      step({ id: "migrations", requires: ["database"], check: satisfied }),
      step({ id: "command", requires: ["migrations"], canSkip: true }),
    ];
    const first = await SetupEngine.open(files.store, steps, clock);
    expect(first.pilotReady()).toBe(false);
    await first.start();
    expect(first.pilotReady()).toBe(false);
    await first.skip("command");
    expect(first.pilotReady()).toBe(true);
    const reopened = await SetupEngine.open(files.store, steps, clock);
    expect(reopened.pilotReady()).toBe(false);
    await reopened.start();
    expect(reopened.pilotReady()).toBe(true);
  });
  it("persists active and waiting durations without carrying monotonic time across restart", async () => {
    const files = memoryStore();
    let tick = 1;
    const timedClock = { monotonic: () => tick, wall: () => 100 };
    const prerequisites = step({
      check: async () => {
        tick = 11;
        return { kind: "needed", reasonCode: "needed" };
      },
      run: async () => {
        tick = 21;
        return { kind: "verified", proof: "checked" };
      },
      verify: async () => {
        tick = 31;
        return { kind: "satisfied", checkedAt: 100, evidence: "checked" };
      },
    });
    const command = step({
      id: "command",
      canSkip: true,
      requires: ["prerequisites"],
      check: async () => {
        tick = 41;
        return { kind: "needed", reasonCode: "consent" };
      },
    });
    const engine = await SetupEngine.open(files.store, [prerequisites, command], timedClock);
    await engine.start();
    expect(engine.snapshot().steps[0]?.activeElapsedMs).toBe(30);
    tick = 81;
    await engine.skip("command");
    expect(engine.snapshot().steps[3]?.waitingElapsedMs).toBe(40);
    const saved = JSON.parse(files.raw()!);
    expect(saved.snapshot.steps[0].activeElapsedMs).toBe(30);
    const reopened = await SetupEngine.open(files.store, [prerequisites, command], {
      monotonic: () => 1_000_000,
      wall: () => 200,
    });
    expect(reopened.snapshot().steps[0]?.activeElapsedMs).toBe(30);
    expect(reopened.snapshot().steps[3]?.waitingElapsedMs).toBe(40);
  });

  it("checks, records pending intent, runs, verifies, and commits a receipt before success", async () => {
    const files = memoryStore();
    const calls: string[] = [];
    const results: string[] = [];
    const operation = step({
      check: async () => {
        calls.push("check");
        return { kind: "needed", reasonCode: "needed" };
      },
      run: async () => {
        calls.push("run");
        expect(JSON.parse(files.raw()!).pending.stepId).toBe("prerequisites");
        return { kind: "verified", proof: "checked" };
      },
      verify: async () => {
        calls.push("verify");
        return { kind: "satisfied", checkedAt: 100, evidence: "checked" };
      },
    });
    const engine = await SetupEngine.open(files.store, [operation], clock);
    engine.onChange((value) => {
      if (value.steps[0]?.status === "succeeded") {
        expect(JSON.parse(files.raw()!).receipts.prerequisites).toEqual({
          kind: "verified",
          proof: "checked",
        });
        results.push("success");
      }
    });
    await engine.start();
    expect(calls).toEqual(["check", "run", "verify"]);
    expect(results).toEqual(["success"]);
    expect(engine.snapshot().complete).toBe(false);
    expect(engine.snapshot().machineReady).toBe(false);
    expect(
      engine
        .snapshot()
        .steps.slice(4)
        .every((row) => row.available === false),
    ).toBe(true);
    expect(
      engine
        .snapshot()
        .steps.slice(4)
        .every((row) => row.status === "pending"),
    ).toBe(true);
  });

  it("freshly rechecks a saved success and reports Already ready without rerunning", async () => {
    const files = memoryStore();
    const run = vi.fn(async () => ({ kind: "verified" as const, proof: "checked" }));
    const first = await SetupEngine.open(files.store, [step({ run })], clock);
    await first.start();
    const second = await SetupEngine.open(
      files.store,
      [
        step({
          check: async () => ({ kind: "satisfied", checkedAt: 200, evidence: "checked" }),
          run,
        }),
      ],
      clock,
    );
    await second.start();
    expect(run).toHaveBeenCalledTimes(1);
    expect(second.snapshot().steps[0]).toMatchObject({
      status: "succeeded",
      reasonCode: "already-ready",
      verifiedAt: 200,
    });
  });

  it("joins a double start to one serialized attempt", async () => {
    const gate = deferred<ReturnType<SetupStep["run"]> extends Promise<infer T> ? T : never>();
    const run = vi.fn(() => gate.promise);
    const engine = await SetupEngine.open(memoryStore().store, [step({ run })], clock);
    const first = engine.start();
    const second = engine.start();
    expect(second).toBe(first);
    gate.resolve({ kind: "verified", proof: "checked" });
    await first;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["check", "run", "verify"] as const)(
    "settles cancellation at the %s await boundary",
    async (boundary) => {
      const gate = deferred<unknown>();
      const cancel = vi.fn(async () => undefined);
      const operation = step({
        check: async () => {
          if (boundary === "check") await gate.promise;
          return { kind: "needed", reasonCode: "needed" };
        },
        run: async () => {
          if (boundary === "run") await gate.promise;
          return { kind: "verified", proof: "checked" };
        },
        verify: async () => {
          if (boundary === "verify") await gate.promise;
          return { kind: "satisfied", checkedAt: 100, evidence: "checked" };
        },
        cancel,
      });
      const engine = await SetupEngine.open(memoryStore().store, [operation], clock);
      const started = engine.start();
      await vi.waitFor(() =>
        expect(engine.snapshot().steps[0]?.status).toBe(
          boundary === "check" ? "checking" : boundary === "run" ? "running" : "verifying",
        ),
      );
      const stopping = engine.cancel();
      await vi.waitFor(() => expect(engine.snapshot().steps[0]?.status).toBe("cancelling"));
      gate.resolve(undefined);
      await Promise.all([started, stopping]);
      expect(cancel).toHaveBeenCalledOnce();
      expect(engine.snapshot().steps[0]?.status).toBe("cancelled");
      expect(engine.snapshot().steps[0]?.status).not.toBe("succeeded");
    },
  );

  it.each(["checking", "running", "verifying"] as const)(
    "does not cross the %s journal write after Cancel",
    async (boundary) => {
      const gate = deferred<unknown>();
      const entered = deferred<unknown>();
      let raw: string | null = null;
      const files: JournalFileBoundary = {
        read: async () => raw,
        exists: async () => raw !== null,
        ensure: async () => undefined,
        write: async (_, value) => {
          if (JSON.parse(value).snapshot.steps[0].status === boundary) {
            entered.resolve(undefined);
            await gate.promise;
          }
          raw = value;
        },
      };
      const check = vi.fn(async () => ({ kind: "needed" as const, reasonCode: "needed" }));
      const run = vi.fn(async () => ({ kind: "verified" as const, proof: "checked" }));
      const verify = vi.fn(async () => ({
        kind: "satisfied" as const,
        checkedAt: 1,
        evidence: "checked",
      }));
      const engine = await SetupEngine.open(
        new SetupJournalStore("/fixture/data", files),
        [step({ check, run, verify })],
        clock,
      );
      const started = engine.start();
      await entered.promise;
      const stopping = engine.cancel();
      gate.resolve(undefined);
      await Promise.all([started, stopping]);
      expect(engine.snapshot().steps[0]?.status).toBe("cancelled");
      if (boundary === "checking") expect(check).not.toHaveBeenCalled();
      if (boundary === "running") expect(run).not.toHaveBeenCalled();
      if (boundary === "verifying") expect(verify).not.toHaveBeenCalled();
    },
  );

  it("rejects late details from an earlier run ID", async () => {
    const engine = await SetupEngine.open(memoryStore().store, [step()], clock);
    const old = engine.snapshot().runId;
    await engine.start();
    expect(engine.publishFor(old, "prerequisites", [{ code: "late", text: "late" }])).toBe(false);
    await engine.cancel();
    expect(engine.publishFor(old, "prerequisites", [{ code: "late", text: "late" }])).toBe(false);
  });

  it("allows optional skip only after dependencies and never counts it as success", async () => {
    const files = memoryStore();
    const command = step({ id: "command", canSkip: true, requires: ["prerequisites"] });
    const engine = await SetupEngine.open(files.store, [step(), command], clock);
    expect((await engine.skip("command")).steps[3]?.status).toBe("pending");
    await engine.start();
    expect(engine.snapshot().steps[3]?.status).toBe("waiting-input");
    await engine.skip("command");
    expect(engine.snapshot().steps[3]?.status).toBe("skipped");
    expect(engine.snapshot().complete).toBe(false);
  });

  it("restores a released database before retrying failed migrations", async () => {
    let databaseRunning = false;
    let databaseStarts = 0;
    let migrationRuns = 0;
    const ready = () => ({ kind: "satisfied" as const, checkedAt: 100, evidence: "ready" });
    const prerequisites = step({ check: async () => ready() });
    const database = step({
      id: "database",
      requires: ["prerequisites"],
      check: async () =>
        databaseRunning ? ready() : { kind: "needed" as const, reasonCode: "database-stopped" },
      run: async () => {
        databaseStarts += 1;
        databaseRunning = true;
        return { kind: "owned", proof: "database" };
      },
      verify: async () => ready(),
    });
    const migrations = step({
      id: "migrations",
      requires: ["database"],
      check: async () => ({ kind: "needed", reasonCode: "migrations-pending" }),
      run: async () => {
        if (!databaseRunning) throw new Error("database not started");
        migrationRuns += 1;
        if (migrationRuns === 1) {
          databaseRunning = false; // Failure cleanup releases the database.
          throw new Error("transient migration failure");
        }
        return { kind: "verified", proof: "migrated" };
      },
      verify: async () => ready(),
    });
    const engine = await SetupEngine.open(
      memoryStore().store,
      [prerequisites, database, migrations],
      clock,
    );
    expect((await engine.start()).steps[2]?.status).toBe("failed");
    expect(databaseStarts).toBe(1);
    expect(migrationRuns).toBe(1);

    expect((await engine.retry("migrations")).steps[2]?.status).toBe("succeeded");
    expect(databaseStarts).toBe(2);
    expect(migrationRuns).toBe(2);
  });

  it("does not trust saved success to authorize a dependent skip before recheck", async () => {
    const files = memoryStore();
    const check = vi.fn(async () => ({
      kind: "satisfied" as const,
      checkedAt: clock.wall(),
      evidence: "ready",
    }));
    const command = step({ id: "command", canSkip: true, requires: ["prerequisites"] });
    const steps = [step({ check }), command];
    const first = await SetupEngine.open(files.store, steps, clock);
    await first.start();
    const reopened = await SetupEngine.open(files.store, steps, clock);
    expect(reopened.snapshot().steps[0]?.status).toBe("succeeded");
    await reopened.skip("command");
    expect(check).toHaveBeenCalledTimes(2);
    expect(reopened.snapshot().steps[3]?.status).toBe("skipped");
  });

  it.each(["retry", "skip"] as const)(
    "rechecks a reopened command prompt before %s",
    async (action) => {
      const files = memoryStore();
      const checks = vi.fn(async () => ({
        kind: "satisfied" as const,
        checkedAt: clock.wall(),
        evidence: "ready",
      }));
      const run = vi.fn(async () => ({ kind: "verified" as const, proof: "command" }));
      const steps = [
        step({ check: checks }),
        step({ id: "command", requires: ["prerequisites"], canSkip: true, run }),
      ];
      await (await SetupEngine.open(files.store, steps, clock)).start();
      const reopened = await SetupEngine.open(files.store, steps, clock);
      expect(reopened.snapshot().steps[3]?.status).toBe("waiting-input");
      const result = await reopened[action]("command");
      expect(checks).toHaveBeenCalledTimes(2);
      expect(result.steps[3]?.status).toBe(action === "retry" ? "succeeded" : "skipped");
      expect(run).toHaveBeenCalledTimes(action === "retry" ? 1 : 0);
    },
  );

  it.each(["retry", "skip"] as const)(
    "keeps %s blocked when a saved prerequisite fails its fresh check",
    async (action) => {
      const files = memoryStore();
      let available = true;
      const run = vi.fn(async () => ({ kind: "verified" as const, proof: "command" }));
      const prerequisites = step({
        check: async () =>
          available
            ? { kind: "satisfied", checkedAt: clock.wall(), evidence: "ready" }
            : { kind: "blocked", reasonCode: "no-longer-ready" },
      });
      const steps = [
        prerequisites,
        step({ id: "command", requires: ["prerequisites"], canSkip: true, run }),
      ];
      await (await SetupEngine.open(files.store, steps, clock)).start();
      available = false;
      const reopened = await SetupEngine.open(files.store, steps, clock);
      const result = await reopened[action]("command");
      expect(result.steps[0]?.status).toBe("failed");
      expect(result.steps[3]?.status).toBe("waiting-input");
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("starts a fresh checked attempt after a successful stop", async () => {
    const files = memoryStore();
    const checks = vi.fn(async () => ({
      kind: "satisfied" as const,
      checkedAt: clock.wall(),
      evidence: "ready",
    }));
    const steps = [
      step({ check: checks }),
      step({ id: "command", requires: ["prerequisites"], canSkip: true }),
    ];
    const engine = await SetupEngine.open(files.store, steps, clock);
    await engine.start();
    await engine.cancel();
    expect(engine.snapshot().steps[3]?.status).toBe("cancelled");
    const reopened = await SetupEngine.open(files.store, steps, clock);
    const restarted = await reopened.start();
    expect(checks).toHaveBeenCalledTimes(2);
    expect(restarted.steps[3]?.status).toBe("waiting-input");
  });

  it("stops before mutation when the pending journal write fails", async () => {
    const files = memoryStore();
    files.reject((raw) => JSON.parse(raw).snapshot.steps[0].status === "running");
    const run = vi.fn(async () => ({ kind: "verified" as const, proof: "checked" }));
    const engine = await SetupEngine.open(files.store, [step({ run })], clock);
    await engine.start();
    expect(run).not.toHaveBeenCalled();
    expect(engine.snapshot().steps[0]).toMatchObject({
      status: "failed",
      reasonCode: "journal-write-failed",
    });
  });

  it("reports incomplete cleanup when rollback fails", async () => {
    const gate = deferred<unknown>();
    let failRollback = true;
    const cancel = vi.fn(async (_context: SetupContext, receipt: StepReceipt | null) => {
      expect(receipt).toEqual({ kind: "owned", proof: "pending" });
    });
    const engine = await SetupEngine.open(
      memoryStore().store,
      [
        step({
          run: async () => {
            await gate.promise;
            return { kind: "owned", proof: "pending" };
          },
          cancel,
          rollback: async () => {
            if (failRollback) throw new Error("failed rollback");
          },
        }),
      ],
      clock,
    );
    const started = engine.start();
    await vi.waitFor(() => expect(engine.snapshot().steps[0]?.status).toBe("running"));
    const stopping = engine.cancel();
    gate.resolve(undefined);
    await Promise.all([started, stopping]);
    expect(engine.snapshot().steps[0]).toMatchObject({
      status: "failed",
      reasonCode: "cleanup-incomplete",
    });
    expect(engine.snapshot().blocked).toBe(true);
    const blocked = engine.snapshot().sequence;
    await engine.start();
    expect(engine.snapshot().sequence).toBe(blocked);
    failRollback = false;
    await engine.cancel();
    expect(engine.snapshot().steps[0]?.status).toBe("cancelled");
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("marks a durable pending operation interrupted and resumes by checking again", async () => {
    const files = memoryStore();
    const gate = deferred<unknown>();
    const first = await SetupEngine.open(
      files.store,
      [
        step({
          run: async () => {
            await gate.promise;
            return { kind: "verified", proof: "done" };
          },
        }),
      ],
      clock,
    );
    const started = first.start();
    await vi.waitFor(() => expect(JSON.parse(files.raw()!).pending?.stepId).toBe("prerequisites"));
    const resumed = await SetupEngine.open(
      files.store,
      [step({ check: async () => ({ kind: "satisfied", checkedAt: 300, evidence: "adopted" }) })],
      clock,
    );
    expect(resumed.snapshot()).toMatchObject({ interrupted: true });
    expect(resumed.snapshot().steps[0]?.status).toBe("interrupted");
    await resumed.resume();
    expect(resumed.snapshot().steps[0]).toMatchObject({
      status: "succeeded",
      reasonCode: "already-ready",
    });
    gate.resolve(undefined);
    await started;
  });

  it("keeps a later pending operation while earlier steps are rechecked", async () => {
    const files = memoryStore();
    const gate = deferred<unknown>();
    const prerequisites = step({
      check: async () => ({ kind: "satisfied", checkedAt: 1, evidence: "checked" }),
    });
    const database = step({
      id: "database",
      requires: ["prerequisites"],
      run: async () => {
        await gate.promise;
        return { kind: "owned", proof: "database" };
      },
    });
    const first = await SetupEngine.open(files.store, [prerequisites, database], clock);
    const started = first.start();
    await vi.waitFor(() => expect(JSON.parse(files.raw()!).pending?.stepId).toBe("database"));
    const resumed = await SetupEngine.open(
      files.store,
      [
        prerequisites,
        step({
          id: "database",
          requires: ["prerequisites"],
          check: async () => ({ kind: "blocked", reasonCode: "review-needed" }),
        }),
      ],
      clock,
    );
    await resumed.resume();
    expect(JSON.parse(files.raw()!).pending?.stepId).toBe("database");
    expect(resumed.snapshot().steps[1]?.status).toBe("failed");
    gate.resolve(undefined);
    await started;
  });

  it("reconciles a mutation after an interrupted journal replacement and restart", async () => {
    const files = memoryStore();
    files.reject((raw) =>
      ["verifying", "failed"].includes(JSON.parse(raw).snapshot.steps[0].status),
    );
    const run = vi.fn(async () => ({ kind: "owned" as const, proof: "created" }));
    const first = await SetupEngine.open(files.store, [step({ run })], clock);
    await first.start();
    expect(run).toHaveBeenCalledOnce();
    expect(JSON.parse(files.raw()!).pending?.stepId).toBe("prerequisites");
    files.reject(null);
    const resumed = await SetupEngine.open(
      files.store,
      [
        step({
          check: async () => ({ kind: "satisfied", checkedAt: 400, evidence: "created" }),
          run,
        }),
      ],
      clock,
    );
    expect(resumed.snapshot().steps[0]?.status).toBe("interrupted");
    await resumed.resume();
    expect(run).toHaveBeenCalledOnce();
    expect(resumed.snapshot().steps[0]?.status).toBe("succeeded");
  });

  it("rechecks a corrupt journal and blocks a newer journal without mutating it", async () => {
    const files = memoryStore();
    files.setRaw("broken");
    const engine = await SetupEngine.open(
      files.store,
      [step({ check: async () => ({ kind: "satisfied", checkedAt: 1, evidence: "checked" }) })],
      clock,
    );
    expect(engine.snapshot().interrupted).toBe(true);
    await engine.resume();
    expect(engine.snapshot().steps[0]?.status).toBe("succeeded");
    files.setRaw('{"version":2}');
    const newer = await SetupEngine.open(files.store, [step()], clock);
    const saved = files.raw();
    await newer.start();
    await newer.cancel();
    expect(newer.snapshot().blocked).toBe(true);
    expect(files.raw()).toBe(saved);
  });
});
