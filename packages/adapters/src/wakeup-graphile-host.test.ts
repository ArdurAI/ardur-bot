import type { BackgroundJobHandlers } from "@ardurbot/adapter-kit";
import type { Runner } from "graphile-worker";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());
const makeWorkerUtils = vi.hoisted(() => vi.fn());

vi.mock("graphile-worker", () => ({
  run: (...args: unknown[]) => run(...args),
  makeWorkerUtils,
}));

import {
  databaseCapacityBackoffMs,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
} from "./wakeup.js";

it("puts all revisions and generations of one document in the same Graphile queue", async () => {
  const addJob = vi.fn();
  makeWorkerUtils.mockResolvedValueOnce({ addJob, release: vi.fn() });
  const publisher = new GraphileJobPublisher({} as Pool);
  for (const generation of [1, 2])
    await publisher.enqueue({
      name: "memory.deliver",
      payload: {
        spaceId: "space",
        userId: "user",
        documentId: "doc",
        revision: generation,
        generation,
      },
    });
  expect(addJob).toHaveBeenCalledTimes(2);
  for (const call of addJob.mock.calls)
    expect(call[2]).toMatchObject({ queueName: "memory.document:space:doc" });
  await publisher.close();
});

it("replaces waiting Git pushes per space and serializes their execution", async () => {
  const addJob = vi.fn(async () => undefined);
  makeWorkerUtils.mockResolvedValueOnce({ addJob, release: vi.fn() });
  const publisher = new GraphileJobPublisher({} as Pool);
  await publisher.enqueue({
    name: "memory.git-push",
    payload: { spaceId: "space", userId: "member", generation: 3 },
    replaceKey: "memory.git-push:space",
  });
  expect(addJob).toHaveBeenCalledWith(
    "memory.git-push",
    expect.anything(),
    expect.objectContaining({
      jobKey: "memory.git-push:space",
      jobKeyMode: "replace",
      queueName: "memory.git:space",
    }),
  );
  await publisher.close();
});

function handlers(): BackgroundJobHandlers {
  return {
    "briefs.maintain": async () => undefined,
    "learning.curate": async () => undefined,
    "learning.review": async () => undefined,
    "memory.git-push": async () => undefined,
    "memory.deliver": async () => undefined,
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mockRunner() {
  const life = deferred();
  // Keep a rejection handler so Node does not treat the mock lifecycle as an
  // unexpected unhandledRejection before the host attaches supervise().
  life.promise.catch(() => undefined);
  const runner = {
    promise: life.promise,
    stop: vi.fn(async () => {
      life.resolve();
    }),
    kill: vi.fn(async () => undefined),
    addJob: vi.fn(),
    events: { on: vi.fn(), off: vi.fn(), once: vi.fn(), emit: vi.fn() },
  } as unknown as Runner;
  return {
    runner,
    rejectLife: (error: unknown) => life.reject(error),
  };
}

const tooMany = Object.assign(new Error("sorry, too many clients already"), { code: "53300" });

describe("databaseCapacityBackoffMs", () => {
  it("matches the worker startup backoff curve", () => {
    expect(databaseCapacityBackoffMs(0)).toBe(200);
    expect(databaseCapacityBackoffMs(3)).toBe(1_600);
    expect(databaseCapacityBackoffMs(8)).toBe(30_000);
    expect(databaseCapacityBackoffMs(20)).toBe(30_000);
  });
});

describe("GraphileJobWorkerHost runner lifecycle", () => {
  afterEach(() => {
    run.mockReset();
  });

  it("keeps import, brief and learning schedules together and strips cron metadata from imports", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const refresh = vi.fn(async () => undefined);
    const host = new GraphileJobWorkerHost({} as Pool, { sleep: async () => undefined });
    try {
      await host.start({ ...handlers(), "local-import.refresh": refresh });
      const { taskList, crontab } = run.mock.calls[0]![0] as {
        taskList: Record<string, (payload: unknown) => Promise<void>>;
        crontab: string;
      };
      expect(crontab.split("\n")).toEqual([
        "0 3 * * 1 learning_curate ?id=learningCurator&fill=1w",
        "0 * * * * local_import_refresh ?id=localImport&fill=1h",
        "*/10 * * * * briefs_maintain ?id=briefMaintenance",
      ]);
      await taskList.local_import_refresh!({
        _cron: { ts: "2026-09-25T12:00:00.000Z", backfilled: false },
      });
      expect(refresh.mock.calls).toEqual([[{}]]);
      await expect(taskList.local_import_refresh!({ spaceId: "space" })).rejects.toThrow(/spaceId/);
    } finally {
      await host.stop();
    }
  });

  it("strips Graphile's cron marker before strict payload validation", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const maintain = vi.fn(async () => undefined);
    const host = new GraphileJobWorkerHost({} as Pool, { sleep: async () => undefined });
    await host.start({ ...handlers(), "briefs.maintain": maintain });
    const { taskList } = run.mock.calls[0]![0] as {
      taskList: Record<string, (payload: unknown) => Promise<void>>;
    };
    await taskList.briefs_maintain!({
      _cron: { ts: "2026-09-25T02:30:00.000Z", backfilled: false },
    });
    await taskList.briefs_maintain!({ runId: "run-1", _cron: { ts: "2026-09-25T02:40:00.000Z" } });
    expect(maintain.mock.calls).toEqual([[{}], [{ runId: "run-1" }]]);
    await expect(
      taskList["briefs.maintain"]!({ runId: "run-1", spaceId: "space" }),
    ).rejects.toThrow(/spaceId/);
    await host.stop();
  });

  it("backs off then restarts when runner.promise rejects with 53300", async () => {
    const first = mockRunner();
    const second = mockRunner();
    run.mockResolvedValueOnce(first.runner).mockResolvedValueOnce(second.runner);
    const sleeps: number[] = [];
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await host.start(handlers());
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        crontab:
          "0 3 * * 1 learning_curate ?id=learningCurator&fill=1w\n*/10 * * * * briefs_maintain ?id=briefMaintenance",
        taskList: expect.objectContaining({ learning_curate: expect.any(Function) }),
      }),
    );
    expect(run).toHaveBeenCalledTimes(1);

    first.rejectLife(tooMany);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(sleeps).toEqual([200]);

    await host.stop();
    expect(second.runner.stop).toHaveBeenCalled();
  });

  it("retries launch with escalating backoff when restart start hits 53300", async () => {
    const first = mockRunner();
    const recovered = mockRunner();
    run
      .mockResolvedValueOnce(first.runner)
      .mockRejectedValueOnce(tooMany)
      .mockResolvedValueOnce(recovered.runner);
    const sleeps: number[] = [];
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await host.start(handlers());
    first.rejectLife(tooMany);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(sleeps).toEqual([200, 400]);

    await host.stop();
    expect(recovered.runner.stop).toHaveBeenCalled();
  });

  it("does not restart when runner.promise rejects for a non-53300 error", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: async () => undefined,
    });
    await host.start(handlers());
    const superviseTask = (host as unknown as { superviseTask: Promise<void> }).superviseTask;

    first.rejectLife(new Error("runner exploded"));
    await expect(superviseTask).rejects.toThrow("runner exploded");
    expect(run).toHaveBeenCalledTimes(1);

    await host.stop();
  });

  it("wakes a pending restart delay when stop is called", async () => {
    const first = mockRunner();
    run.mockResolvedValueOnce(first.runner);
    const sleepStarted = deferred();
    const host = new GraphileJobWorkerHost({} as Pool, {
      sleep: () => {
        sleepStarted.resolve();
        return new Promise(() => undefined);
      },
    });
    await host.start(handlers());
    first.rejectLife(tooMany);
    await sleepStarted.promise;

    await host.stop();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
