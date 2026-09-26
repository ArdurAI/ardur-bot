import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { denyExternalTcp } from "../scoreboard/replay/offline.js";
import { isOwnedReplayDatabase } from "../scoreboard/replay/postgres.js";
import { ArdurAdapter } from "./adapters/ardur.js";
import { HermesContainerAdapter } from "./adapters/hermes-container.js";
import { parseBudget, requireValue } from "./budget.js";
import { AdmittedDepartmentServices, TrialAdmission } from "./containers/admission.js";
import { ContainerComputer } from "./containers/computer.js";
import { COMPUTER_IMAGE } from "./containers/policy.js";
import { ContainerSession } from "./containers/session.js";
import { createTrialDirectory, destroyOwnedDirectory } from "./isolation.js";
import type { LiveProducts, LiveRun } from "./live.js";
import { runLiveTrials } from "./live.js";
import { repositoryRoot, sanitize } from "./provenance.js";
import {
  cachedPostgresImage,
  createFixtureApp,
  provisionOwnedPostgres,
  removeOwnedContainers,
  spawnHarnessChild,
} from "./rpc-self-test.js";
import type { PairPlan } from "./scheduler.js";
import { ServingWitness } from "./serving.js";

/**
 * The actual products: Ardur's ordinary app, queue, worker and executor on a fresh disposable
 * database with the confined container computer, and the pinned Hermes image in its own confined
 * container. Runs only inside the allowlisted child the CLI starts.
 */
export async function openLiveProducts(root: string): Promise<LiveProducts> {
  const postgres = await provisionOwnedPostgres(root);
  const databases: { trialId: string; port: number; disposableLease: boolean }[] = [];
  return {
    describe: () => ({
      ardur: "ordinary app, disposable database, confined container computer, pre-effect admission",
      hermes: "pinned image in a confined container",
      networkConfinement: "loopback-only while a product runs",
      databases,
    }),
    async create(setup) {
      if (setup.product === "hermes")
        return {
          adapter: new HermesContainerAdapter({
            ledger: setup.ledger,
            observedRoute: setup.observedRoute,
            preapproveConsent: true,
          }),
        };
      const database = await postgres.fresh();
      databases.push({
        trialId: setup.id,
        port: Number(new URL(database.url).port),
        disposableLease: isOwnedReplayDatabase(database.url),
      });
      let session: ContainerSession | undefined;
      try {
        session = await ContainerSession.open({
          root: setup.directory.state,
          image: COMPUTER_IMAGE,
          budget: setup.ledger.budget,
          wallMs: Math.floor(setup.ledger.remainingMs(setup.id)),
        });
        const admission = new TrialAdmission(setup.id, setup.ledger, setup.emit, [
          ...setup.task.allowedTools,
          "mcp_execute_tool",
        ]);
        const container = new ContainerComputer(session, setup.task, admission);
        const services = new AdmittedDepartmentServices(admission);
        process.env.DATABASE_URL = database.url;
        const owned = session;
        return {
          adapter: new ArdurAdapter({
            databaseUrl: database.url,
            dataDir: setup.directory.state,
            services,
            sandbox: container,
            container,
            mode: "live",
            createApp: () =>
              createFixtureApp({
                databaseUrl: database.url,
                dataDir: setup.directory.state,
                sandbox: container,
                services,
                containerMode: true,
              }),
          }),
          release: async () => {
            await owned.destroy();
            await database.close();
          },
        };
      } catch (error) {
        await session?.destroy();
        await database.close();
        throw error;
      }
    },
    // Docker control stays in subprocesses; in-process TCP is loopback only while a product runs.
    confine: denyExternalTcp,
    close: () => postgres.close(),
  };
}

/** Child entry: reads the admitted budget and plan, runs every trial, and writes the run. */
async function liveChild(root: string, inputFile: string, resultFile: string) {
  const input = JSON.parse(await readFile(inputFile, "utf8")) as {
    budget: unknown;
    plan: PairPlan[];
    graderHash: string;
  };
  const budget = parseBudget(input.budget);
  requireValue(/^[a-f0-9]{64}$/.test(input.graderHash), "Grader commitment required");
  try {
    const run = await runLiveTrials({
      budget,
      plan: input.plan,
      graderHash: input.graderHash,
      products: await openLiveProducts(root),
      serving: new ServingWitness(budget),
      root,
    });
    await writeFile(resultFile, JSON.stringify({ status: "finished", run }), { flag: "wx" });
  } catch (error) {
    await writeFile(
      resultFile,
      JSON.stringify({
        status: "failed",
        failure: sanitize(error instanceof Error ? error.message : String(error), [
          root,
          repositoryRoot,
        ]),
      }),
      { flag: "wx" },
    );
    throw error;
  }
}

/** The budget's global wall limit plus a fixed margin for provisioning, stop grace and cleanup. */
export function liveChildTimeoutMs(budget: { global: { wallMs: number } }) {
  return budget.global.wallMs + 600000;
}

/** Parent side: runs the trials in the allowlisted child and returns its retained run. */
export async function runLiveChild(input: {
  budget: ReturnType<typeof parseBudget>;
  plan: PairPlan[];
  graderHash: string;
}) {
  const resource = await createTrialDirectory(tmpdir());
  try {
    cachedPostgresImage();
    const inputFile = path.join(resource.state, "live-input.json");
    const resultFile = path.join(resource.state, "live-run.json");
    await writeFile(inputFile, JSON.stringify(input), { flag: "wx", mode: 0o600 });
    const { code, diagnostics } = await spawnHarnessChild({
      resource,
      module: fileURLToPath(import.meta.url),
      args: ["--live-child", resource.root, inputFile, resultFile],
      timeoutMs: liveChildTimeoutMs(input.budget),
    });
    let result: { status: string; run?: LiveRun; failure?: string };
    try {
      result = JSON.parse(await readFile(resultFile, "utf8"));
    } catch {
      result = { status: "failed", failure: "The live child wrote no run" };
    }
    requireValue(
      result.status === "finished" && result.run,
      `Live run incomplete (child exit ${code}): ${result.failure ?? "unknown failure"}. ${diagnostics.slice(-2000)}`,
    );
    return {
      ...result.run,
      protocolResults: { ...result.run.protocolResults, childExitCode: code, diagnostics },
    };
  } finally {
    removeOwnedContainers(resource.owner);
    await destroyOwnedDirectory(resource);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  (args[0] === "--live-child" && args.length === 4
    ? liveChild(args[1]!, args[2]!, args[3]!)
    : Promise.reject(new Error("Started only by the versus CLI's live lane"))
  ).catch((error) => {
    console.error(sanitize(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
