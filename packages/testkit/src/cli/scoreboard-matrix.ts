import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CrashId, MatrixPlan, MatrixResult } from "../scoreboard/experiments/catalog.js";
import {
  experimentCoverage,
  matrixExitCode,
  matrixPlan,
} from "../scoreboard/experiments/catalog.js";
import {
  matrixEvidence,
  matrixSourceBinding,
  requireCachedMatrixImages,
  writeMatrixArtifact,
} from "../scoreboard/experiments/evidence.js";
import { createScoreboardManifest } from "../scoreboard/manifest.js";
import { credentialFreeEnvironment } from "../scoreboard/replay/offline.js";

async function main() {
  const options = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(plan|select|fault|output|declare)=(.+)$/.exec(arg);
    if (!match || options.has(match[1]!))
      throw new Error("Use unique --plan/--select/--fault/--output/--declare=value arguments");
    options.set(match[1]!, match[2]!);
  }
  const plan = matrixPlan((options.get("plan") ?? "smoke") as MatrixPlan);
  const select = (options.get("select") ?? "O2,O3,O4,O5,O6,O7,O8,O9,O10,O11").split(",");
  if (
    new Set(select).size !== select.length ||
    select.some((id) => !/^O(?:[1-9]|1[0-3])$/.test(id))
  )
    throw new Error("Invalid experiment selection");
  const faults = options.get("fault")?.split(",") ?? plan.faults.map((boundary) => boundary.id);
  if (
    faults.some((id) => !plan.faults.some((boundary) => boundary.id === id)) ||
    new Set(faults).size !== faults.length
  )
    throw new Error("Invalid crash selection");
  if (options.has("declare") && options.get("declare") !== "true")
    throw new Error("Use --declare=true");
  const binding = await matrixSourceBinding();
  const output = options.get("output") ?? `.context/performance/matrix-${Date.now()}`;
  const manifest = createScoreboardManifest();
  const coverage = experimentCoverage();
  const reports: Array<{ path: string; sha256: string }> = [];
  const results: MatrixResult[] = [];
  reports.push(
    await writeMatrixArtifact(output, "binding", {
      ...binding,
      plan,
      select,
      faults,
      manifest,
      coverage,
      createdAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        packaged: false,
        cacheState: "fresh-database-and-workspace; OS and dependency caches uncontrolled",
        fixedRelease: "not-supplied",
        humanReviewMinutes: null,
        subscriptionQuotas: null,
        pricedCost: null,
      },
    }),
  );
  const record = async (
    id: string,
    experiment: MatrixResult["experiment"],
    execute: () => Promise<MatrixResult>,
  ) => {
    let result: MatrixResult;
    try {
      result = await execute();
    } catch (error) {
      result = {
        id,
        experiment,
        tier: "T1",
        status: "incomplete",
        checks: {},
        measurements: {
          error:
            error instanceof Error
              ? error.message
                  .replace(/(?:postgres\S+|\/Users\/\S+|\/Volumes\/\S+)/g, "<redacted>")
                  .slice(0, 500)
              : "execution-failed",
        },
        coverage: [],
        gaps: ["Attempt failed before complete observations; retained, not discarded."],
      };
    }
    results.push(result);
    reports.push(await writeMatrixArtifact(output, "result", result));
    process.stdout.write(`${result.id}: ${result.status}\n`);
  };
  if (options.get("declare") !== "true") {
    const images = requireCachedMatrixImages();
    reports.push(await writeMatrixArtifact(output, "images", images));
    const clean = credentialFreeEnvironment(process.env);
    for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
    process.env.NODE_ENV = "test";
    process.env.LOG_LEVEL = "off";
    const { provisionReplayPostgres } = await import("../scoreboard/replay/postgres.js");
    const postgres = await provisionReplayPostgres();
    const trial = async (
      id: string,
      experiment: MatrixResult["experiment"],
      execute: (url: string) => Promise<MatrixResult>,
    ) =>
      record(id, experiment, async () => {
        const database = await postgres.fresh();
        try {
          return await execute(database.url);
        } finally {
          await database.close();
        }
      });
    try {
      if (select.includes("O9")) {
        const { runCrashCase } = await import("../scoreboard/faults/process.js");
        for (const id of faults) await trial(id, "O9", (url) => runCrashCase(url, id as CrashId));
        if (!options.has("fault"))
          for (const control of ["revoke", "pin"] as const)
            await trial(`crash-03-${control}`, "O9", (url) =>
              runCrashCase(url, "crash-03", control),
            );
      }
      if (select.includes("O5")) {
        const { runMemoryScale } = await import("../scoreboard/experiments/memory.js");
        for (const item of plan.memory)
          await trial(`O5-${item.documents}-${item.revisions}`, "O5", (url) =>
            runMemoryScale(url, item.documents, item.revisions),
          );
      }
      if (select.includes("O7")) {
        const { runQueueLoad } = await import("../scoreboard/load/queue.js");
        for (const item of plan.load)
          await trial(`O7-${item.demands}-${item.arrival}`, "O7", (url) => runQueueLoad(url, item));
        await trial("O7-callback-capacity", "O7", (url) =>
          runQueueLoad(url, { demands: 4, arrival: "open-loop", callbacks: true }),
        );
      }
      for (const id of select.filter((id) => !["O5", "O7", "O9"].includes(id))) {
        const { runComponentExperiments } = await import("../scoreboard/experiments/components.js");
        await trial(id, id, (url) => runComponentExperiments(url, id, plan));
      }
    } finally {
      await postgres.close();
    }
  }
  const finalBinding = await matrixSourceBinding();
  reports.push(await writeMatrixArtifact(output, "scoreboard-fragments", matrixEvidence(results)));
  const changed =
    binding.diffDigest !== finalBinding.diffDigest ||
    binding.baseCommit !== finalBinding.baseCommit;
  const exitCode = changed ? 2 : matrixExitCode(results, plan.name === "release");
  const summary = {
    binding,
    sourceChangedDuringRun: changed,
    plan,
    coverage,
    results: results.map(({ id, status, checks }) => ({ id, status, checks })),
    artifacts: reports,
    releaseEligible: false,
    exitCode,
    reason:
      "Selected smoke/component cases cannot satisfy all experiment variants, paired timings, fixed-release, platform or live acceptance.",
  };
  const final = await writeMatrixArtifact(output, "summary", summary);
  await writeFile(path.join(output, "index.json"), `${JSON.stringify(final)}\n`, { flag: "wx" });
  // Read back the persisted index before reporting success.
  JSON.parse(await readFile(path.join(output, "index.json"), "utf8"));
  process.stdout.write(
    `${JSON.stringify({ results: results.length, exitCode, index: "index.json", releaseEligible: false })}\n`,
  );
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message.replace(/(?:postgres\S+|\/Users\/\S+|\/Volumes\/\S+)/g, "<redacted>") : "Matrix setup failed"}\n`,
  );
  process.exitCode = 2;
});
