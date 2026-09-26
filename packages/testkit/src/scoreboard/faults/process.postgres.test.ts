import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatrixResult } from "../experiments/catalog.js";
import {
  matrixEvidence,
  requireCachedMatrixImages,
  writeMatrixArtifact,
  writeMatrixEvidence,
} from "../experiments/evidence.js";
import { CRASH_BOUNDARIES } from "../manifest.js";
import { provisionReplayPostgres } from "../replay/postgres.js";
import { runCrashCase } from "./process.js";

// Explicit opt-in: requires a local Docker socket and already cached PostgreSQL/Ryuk images.
// Default CI unit jobs have no such prerequisite; their skips do not count as durable acceptance.
describe.skipIf(process.env.SCOREBOARD_MATRIX_POSTGRES !== "1")(
  "process faults on owned disposable PostgreSQL (requires SCOREBOARD_MATRIX_POSTGRES=1 and cached images)",
  () => {
    let postgres: Awaited<ReturnType<typeof provisionReplayPostgres>>;
    const results: MatrixResult[] = [];
    const retain = async (result: MatrixResult) => {
      results.push(result);
      const directory = process.env.SCOREBOARD_MATRIX_REPORT_DIR;
      if (directory) await writeMatrixArtifact(directory, "result", result);
      return result;
    };
    beforeAll(async () => {
      requireCachedMatrixImages();
      postgres = await provisionReplayPostgres();
    }, 300000);
    afterAll(async () => {
      try {
        const directory = process.env.SCOREBOARD_MATRIX_REPORT_DIR;
        if (directory) await writeMatrixEvidence(directory, results);
      } finally {
        await postgres?.close();
      }
      // What the workers recorded must complete these crashes once all of their runs ran here.
      // crash-06 dies on its completion commit, before the executor traces that terminal.
      const ran = new Set(results.map((result) => result.id));
      const runs: Record<string, string[]> = {
        "crash-03": ["crash-03", "crash-03-revoke", "crash-03-pin"],
        "crash-04": ["crash-04"],
        "crash-05": ["crash-05"],
        "crash-07": ["crash-07"],
      };
      for (const row of matrixEvidence(results).crashes)
        if (runs[row.id]?.every((id) => ran.has(id)))
          expect(row, row.id).toMatchObject({ status: "complete", missingReason: null });
    });
    it.concurrent.each(CRASH_BOUNDARIES)(
      "$id: $name expects $expected",
      async ({ id }) => {
        const database = await postgres.fresh();
        try {
          const result = await retain(await runCrashCase(database.url, id));
          expect(result.checks, JSON.stringify(result.measurements)).not.toEqual({});
          expect(Object.values(result.checks), JSON.stringify(result)).not.toContain(false);
          expect(result.coverage).toContain("SIGKILL");
        } finally {
          await database.close();
        }
      },
      750000,
    );
    it.concurrent.each(["revoke", "pin"] as const)(
      "rechecks %s after an intended effect crashes",
      async (control) => {
        const database = await postgres.fresh();
        try {
          const result = await retain(await runCrashCase(database.url, "crash-03", control));
          expect(Object.values(result.checks), JSON.stringify(result)).not.toContain(false);
        } finally {
          await database.close();
        }
      },
      750000,
    );
  },
);

it("refuses a loopback database not issued by the provisioner", async () => {
  await expect(
    runCrashCase("postgresql://fixture@127.0.0.1/scoreboard_trial_1", "crash-01"),
  ).rejects.toThrow("not provisioned");
});
