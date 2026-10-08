import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@ardurbot/db";
import { createDb } from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RestartDrain } from "./restart-drain.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// The integration harness gives this suite its own migrated database.
describePostgres("restart admission locking (PostgreSQL)", () => {
  const applicationName = `restart-lock-${randomUUID()}`;
  let db: ReturnType<typeof createDb>;
  let drain: RestartDrain;

  beforeAll(async () => {
    db = createDb(databaseUrl!, { applicationName, poolMax: 4 });
    drain = new RestartDrain(db.prisma);
    await drain.initialize();
  });
  afterAll(async () => {
    if (!db) return;
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function waitForBlockedQuery() {
    await vi.waitFor(
      async () => {
        const { rows } = await db.pool.query<{ blocked: number }>(
          `SELECT count(*)::int AS blocked FROM pg_stat_activity
           WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0`,
          [applicationName],
        );
        expect(rows[0]?.blocked).toBe(1);
      },
      { timeout: 5_000, interval: 25 },
    );
  }

  it("allows concurrent admissions but holds drain publication until both claims commit", async () => {
    const release = deferred();
    const ready = [deferred(), deferred()];
    const claims = ready.map((entered) =>
      db.prisma.$transaction(
        async (tx) => {
          expect(await drain.admits(tx)).toBe(true);
          entered.resolve();
          await release.promise;
        },
        { timeout: 15_000 },
      ),
    );
    const count = vi.spyOn(db.prisma.run, "count");
    const id = randomUUID();
    let updating: ReturnType<RestartDrain["begin"]> | undefined;
    try {
      await Promise.race([
        Promise.all(ready.map((entered) => entered.promise)),
        Promise.all(claims),
      ]);
      updating = drain.begin(id, 1_000);
      await waitForBlockedQuery();
      expect(count).not.toHaveBeenCalled();
      release.resolve();
      await Promise.all(claims);
      expect(await updating).toMatchObject({ ok: true, activeAtStart: 0 });
      expect(count).toHaveBeenCalled();
      expect(await db.prisma.$transaction((tx) => drain.admits(tx))).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled(claims);
      await updating;
      await drain.clear(id);
      count.mockRestore();
    }
  });

  it("blocks an admission behind drain publication and reads the committed closed state", async () => {
    const release = deferred();
    const ready = deferred();
    const id = randomUUID();
    // Hold the actual begin upsert uncommitted so the opposite lock ordering is observable.
    const updating = db.prisma.$transaction(
      async (tx) => {
        const writer = new RestartDrain(tx as unknown as PrismaClient);
        expect(await writer.begin(id, 1_000)).toMatchObject({ ok: true });
        ready.resolve();
        await release.promise;
      },
      { timeout: 15_000 },
    );
    let admitting: Promise<boolean> | undefined;
    let admitted = false;
    try {
      await Promise.race([ready.promise, updating]);
      admitting = db.prisma.$transaction(async (tx) => {
        const result = await drain.admits(tx);
        admitted = true;
        return result;
      });
      await waitForBlockedQuery();
      expect(admitted).toBe(false);
      release.resolve();
      await updating;
      expect(await admitting).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([updating, ...(admitting ? [admitting] : [])]);
      await drain.clear(id);
    }
  });
});
