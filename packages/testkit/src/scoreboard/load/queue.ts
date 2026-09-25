import { setTimeout as delay } from "node:timers/promises";
import { createDb } from "@ardurbot/db";
import { GraphileJobPublisher, GraphileJobWorkerHost } from "../../../../adapters/src/wakeup.js";
import type { MatrixResult } from "../experiments/catalog.js";
import { fixtureHandlers, until } from "../experiments/durable.js";
import { seededRandom } from "../experiments/schedules.js";
import { isOwnedReplayDatabase } from "../replay/postgres.js";

export async function runQueueLoad(
  databaseUrl: string,
  options: {
    demands: number;
    arrival: "open-loop" | "fixed-concurrency";
    callbacks?: boolean;
    seed?: number;
    deadlineMs?: number;
  },
): Promise<MatrixResult> {
  if (!isOwnedReplayDatabase(databaseUrl)) throw new Error("Unowned matrix database");
  if (
    ![1, 4, 16].includes(options.demands) ||
    !["open-loop", "fixed-concurrency"].includes(options.arrival)
  )
    throw new Error("Invalid load dimensions");
  const deadlineMs = options.deadlineMs ?? 15000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 60000)
    throw new Error("Invalid load deadline");
  const db = createDb(databaseUrl);
  const jobs = new GraphileJobPublisher(db.pool);
  const host = new GraphileJobWorkerHost(db.pool, {
    concurrency: 4,
    pollInterval: 20,
    noHandleSignals: true,
  });
  const random = seededRandom(options.seed ?? 606);
  const samples: Array<{
    id: string;
    kind: string;
    eligibleMs: number;
    acquiredMs: number | null;
    terminalMs: number | null;
    callbackCompleted: boolean | null;
  }> = [];
  const start = performance.now();
  const time = () => performance.now() - start;
  let active = 0;
  let maxActive = 0;
  let workerErrors = 0;
  let callbackParents = 0;
  const execute = async (id: string, kind: string) => {
    const row = samples.find((item) => item.id === id);
    if (!row) return;
    row.acquiredMs = time();
    maxActive = Math.max(maxActive, ++active);
    try {
      if (options.callbacks && kind === "interactive") {
        callbackParents++;
        if (!(await until(async () => callbackParents >= Math.min(4, options.demands), 1500)))
          throw new Error("Callback saturation barrier not reached");
        const callback = `${id}-callback`;
        samples.push({
          id: callback,
          kind: "callback",
          eligibleMs: time(),
          acquiredMs: null,
          terminalMs: null,
          callbackCompleted: null,
        });
        await jobs.enqueue({ name: "computer.update", payload: { updateId: callback } });
        row.callbackCompleted = await until(
          async () => samples.some((item) => item.id === callback && item.terminalMs !== null),
          Math.min(500, deadlineMs),
        );
      } else await delay(kind === "interactive" ? 20 : 10);
      await db.pool.query(
        "INSERT INTO scoreboard_fixture.load_results (id, kind) VALUES ($1, $2)",
        [id, kind],
      );
      row.terminalMs = time();
    } catch {
      workerErrors++;
    } finally {
      active--;
    }
  };
  try {
    await db.pool.query("CREATE SCHEMA IF NOT EXISTS scoreboard_fixture");
    await db.pool.query(
      "CREATE TABLE scoreboard_fixture.load_results (id text PRIMARY KEY, kind text NOT NULL)",
    );
    await host.start(
      fixtureHandlers({
        "run.continue": async ({ runId }) => execute(runId, "interactive"),
        "learning.review": async ({ runId }) => execute(runId, "learning"),
        "memory.deliver": async ({ documentId }) => execute(documentId, "memory"),
        "computer.update": async ({ updateId }) => execute(updateId, "callback"),
      }),
    );
    const offer = async (index: number) => {
      const id = `load-${index}`;
      samples.push({
        id,
        kind: "interactive",
        eligibleMs: time(),
        acquiredMs: null,
        terminalMs: null,
        callbackCompleted: null,
      });
      await jobs.enqueue({ name: "run.continue", payload: { runId: id } });
      return id;
    };
    const count = options.callbacks ? options.demands : options.demands * 2;
    const offeredAt: number[] = [];
    if (options.arrival === "open-loop") {
      // Absolute scheduled arrivals do not move when the service is slow.
      const origin = performance.now();
      await Promise.all(
        Array.from({ length: count }, async (_, i) => {
          const at = options.callbacks ? 0 : i * 2 + Math.floor(random() * 2);
          offeredAt[i] = at;
          await delay(Math.max(0, origin + at - performance.now()));
          await offer(i);
        }),
      );
    } else {
      let next = 0;
      await Promise.all(
        Array.from({ length: options.demands }, async () => {
          while (next < count) {
            const index = next++;
            offeredAt[index] = time();
            const id = await offer(index);
            if (
              !(await until(
                async () => samples.some((item) => item.id === id && item.terminalMs !== null),
                deadlineMs,
              ))
            )
              break;
          }
        }),
      );
    }
    if (!options.callbacks) {
      for (const kind of ["learning", "memory"] as const) {
        const id = `${kind}-burst`;
        samples.push({
          id,
          kind,
          eligibleMs: time(),
          acquiredMs: null,
          terminalMs: null,
          callbackCompleted: null,
        });
        if (kind === "learning")
          await jobs.enqueue({
            name: "learning.review",
            payload: {
              runId: id,
              historyGeneration: 0,
              evidenceWatermark: "fixture",
              policyVersion: "fixture",
            },
          });
        else
          await jobs.enqueue({
            name: "memory.deliver",
            payload: {
              spaceId: "fixture",
              userId: "fixture",
              documentId: id,
              revision: 1,
              generation: 0,
            },
          });
      }
    }
    const drained = await until(
      async () => samples.every((row) => row.terminalMs !== null),
      deadlineMs,
    );
    const elapsedMs = time();
    const countRows = await db.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM scoreboard_fixture.load_results",
    );
    const completed = samples.filter((row) => row.terminalMs !== null).length;
    const checks = {
      allOfferedCompleted:
        drained && samples.filter((row) => row.kind === "interactive").length === count,
      durableCompletion: Number(countRows.rows[0]!.count) === completed,
      capacityBound: maxActive <= 4,
      noWorkerErrors: workerErrors === 0,
      callbackProgress: samples.every((row) => row.callbackCompleted !== false),
    };
    return {
      id: `O7-${options.demands}-${options.arrival}${options.callbacks ? "-callbacks" : ""}`,
      experiment: "O7",
      tier: "T1",
      status: Object.values(checks).every(Boolean) ? "passed" : "finding",
      checks,
      measurements: {
        options,
        workerConcurrency: 4,
        poolMax: 4,
        scheduledArrivalsMs: offeredAt,
        offered: samples.length,
        completed,
        failed: samples.length - completed,
        callbackTimeouts: samples.filter((row) => row.callbackCompleted === false).length,
        elapsedMs,
        throughputPerSecond: (completed * 1000) / elapsedMs,
        oldestOutstandingAgeMs: Math.max(
          0,
          ...samples
            .filter((row) => row.terminalMs === null)
            .map((row) => elapsedMs - row.eligibleMs),
        ),
        samples,
      },
      coverage: [
        "real-graphile",
        "real-postgresql",
        "monotonic-queue-wait",
        "fixed-four-worker-slots",
        "bounded-callback-deadline",
      ],
      gaps: [
        "Handlers isolate queue capacity; executor admission, real maintenance/delegation and native callback placement need their own integrated load trials.",
        "Shared local runner; timing is diagnostic, without a paired interval.",
      ],
    };
  } finally {
    await host.stop();
    await jobs.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
}
