import { createDb } from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionReplayPostgres } from "../replay/postgres.js";
import { matrixPlan } from "./catalog.js";
import { runComponentExperiments } from "./components.js";
import { observeCommittedWrites } from "./durable.js";
import { requireCachedMatrixImages } from "./evidence.js";
import { runMemoryScale } from "./memory.js";

describe.skipIf(process.env.SCOREBOARD_MATRIX_POSTGRES !== "1")(
  "component experiments (requires SCOREBOARD_MATRIX_POSTGRES=1 and cached disposable PostgreSQL)",
  () => {
    let postgres: Awaited<ReturnType<typeof provisionReplayPostgres>>;
    beforeAll(async () => {
      requireCachedMatrixImages();
      postgres = await provisionReplayPostgres();
    }, 300000);
    afterAll(async () => {
      await postgres?.close();
    });
    it("observes committed batches once and never observes a rolled back transaction", async () => {
      const database = await postgres.fresh();
      const db = createDb(database.url);
      try {
        const counts: number[] = [];
        const observed = observeCommittedWrites(db.prisma, async () => {
          counts.push(await db.prisma.user.count());
        });
        await observed.$transaction(
          ["one", "two"].map((id) =>
            observed.user.create({
              data: { id, name: "Synthetic fixture", email: `${id}@example.test` },
            }),
          ),
        );
        expect(counts).toEqual([2]);
        await expect(
          observed.$transaction(async (transaction) => {
            await transaction.user.deleteMany();
            throw new Error("Synthetic rollback");
          }),
        ).rejects.toThrow("Synthetic rollback");
        expect(counts).toEqual([2]);
        expect(await observed.user.count()).toBe(2);
        await observed.user.deleteMany();
        expect(counts).toEqual([2, 0]);
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
        await database.close();
      }
    });
    it.each(["O2", "O3", "O6", "O10", "O11"])(
      "%s preserves its declared safety checks",
      async (id) => {
        const db = await postgres.fresh();
        try {
          const result = await runComponentExperiments(db.url, id, matrixPlan("smoke"));
          expect(Object.keys(result.checks).length).toBeGreaterThan(0);
          expect(Object.values(result.checks), JSON.stringify(result)).not.toContain(false);
          expect(result.gaps.length).toBeGreaterThan(0);
        } finally {
          await db.close();
        }
      },
      60000,
    );
    it("detects an omitted approval, negation and source while rejecting stale/failed summaries", async () => {
      const db = await postgres.fresh();
      try {
        const result = await runComponentExperiments(db.url, "O4", matrixPlan("smoke"));
        expect(result.checks.noStaleOrFailedReplacement).toBe(true);
        expect(result.checks.omissionNotCommitted).toBe(false);
        expect(result.checks.criticalFactRetention).toBe(false);
        expect(result.status).toBe("finding");
      } finally {
        await db.close();
      }
    });
    it("observes revision overfetch while denying another user's document", async () => {
      const db = await postgres.fresh();
      try {
        const result = await runMemoryScale(db.url, 100, 20);
        expect(result.checks.headContent).toBe(true);
        expect(result.checks.scopePreserved).toBe(true);
        expect(result.checks.historicalRevisionsNotMaterialized).toBe(false);
        expect(result.status).toBe("finding");
        const reads = result.measurements.materializedReads as Array<{
          documents: number;
          revisions: number;
          bytes: number;
        }>;
        expect(
          reads.some((read) => read.documents > 1 && read.revisions > 20 && read.bytes > 256),
        ).toBe(true);
      } finally {
        await db.close();
      }
    });
  },
);
