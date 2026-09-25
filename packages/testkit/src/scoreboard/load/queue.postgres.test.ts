import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireCachedMatrixImages } from "../experiments/evidence.js";
import { provisionReplayPostgres } from "../replay/postgres.js";
import { runQueueLoad } from "./queue.js";

describe.skipIf(process.env.SCOREBOARD_MATRIX_POSTGRES !== "1")(
  "durable load (requires opt-in Docker and cached images)",
  () => {
    let postgres: Awaited<ReturnType<typeof provisionReplayPostgres>>;
    beforeAll(async () => {
      requireCachedMatrixImages();
      postgres = await provisionReplayPostgres();
    }, 300000);
    afterAll(async () => {
      await postgres?.close();
    });
    it.each(["open-loop", "fixed-concurrency"] as const)(
      "finishes interactive and maintenance work with %s arrivals",
      async (arrival) => {
        const database = await postgres.fresh();
        try {
          const result = await runQueueLoad(database.url, { demands: 4, arrival });
          expect(result.status, JSON.stringify(result)).toBe("passed");
          expect(result.measurements.completed).toBe(10);
        } finally {
          await database.close();
        }
      },
    );
    it("detects the deliberately saturated same-queue callback dependency within its deadline", async () => {
      const database = await postgres.fresh();
      try {
        const result = await runQueueLoad(database.url, {
          demands: 4,
          arrival: "open-loop",
          callbacks: true,
        });
        expect(result.status).toBe("finding");
        expect(result.measurements.callbackTimeouts).toBeGreaterThan(0);
        expect(result.measurements.completed).toBe(8);
      } finally {
        await database.close();
      }
    });
  },
);
