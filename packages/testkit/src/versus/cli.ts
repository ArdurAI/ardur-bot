import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentDigest } from "../scoreboard/manifest.js";
import { DEPARTMENT_TASKS } from "../scoreboard/tasks/catalog.js";
import type { Budget } from "./budget.js";
import { parseBudget, requireValue } from "./budget.js";
import { HERMES_CONTAINER_REVISION } from "./containers/policy.js";
import type { inspectImage } from "./containers/session.js";
import { writeEvidence } from "./evidence.js";
import type { LiveRun } from "./live.js";
import { assessLiveContainerGate, containerHermesIdentity, liveVerdict } from "./live.js";
import { HERMES_RESEARCH_REVISION } from "./manifest.js";
import { inspectBuild, inspectHermes, sanitize } from "./provenance.js";
import type { PairPlan } from "./scheduler.js";
import { planPairs } from "./scheduler.js";

export const HELP = `Ardur Bot versus Hermes benchmark

pnpm --filter @ardurbot/testkit exec tsx src/versus/cli.ts --dry-run --suite core24 --out ./artifacts/versus/dry
pnpm --filter @ardurbot/testkit exec tsx src/versus/cli.ts --self-test --out ./artifacts/versus/self-test
pnpm --filter @ardurbot/testkit exec tsx src/versus/cli.ts --live --lane container --budget ./canary-budget.json --container-report ./container-qualification.json --container-cohort-approval approved --out ./artifacts/versus/live

Optional: --hermes-executable <path> --hermes-source <path>
No arguments prints help. Dry run performs no network or product startup.
Self-test uses synthetic loopback providers and scripted product doubles.
Live runs only the owner-approved container canary once every cohort gate passes.
Exit 0: every run executed and its evidence validated. 1: a cap or deadline stopped a run.
2: refused or incomplete. Native live stays refused.
`;
export interface CliOptions {
  mode: "dry-run" | "self-test" | "live" | "help";
  suite: "core24";
  out: string;
  budget?: string;
  expectedRevision?: string;
  executable?: string;
  source?: string;
  lane?: "container";
  containerReport?: string;
  approval?: string;
}
export function parseArguments(args: string[]): CliOptions {
  if (!args.length || (args.length === 1 && ["--help", "-h"].includes(args[0]!)))
    return { mode: "help", suite: "core24", out: "" };
  const parsed: Record<string, string | boolean> = {};
  const switches = new Set(["--dry-run", "--self-test", "--live"]);
  const values = new Set([
    "--suite",
    "--out",
    "--budget",
    "--expected-hermes-revision",
    "--hermes-executable",
    "--hermes-source",
    "--lane",
    "--container-report",
    "--container-cohort-approval",
  ]);
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    requireValue(
      !(key in parsed) && (switches.has(key) || values.has(key)),
      "Unknown or repeated option",
    );
    if (switches.has(key)) parsed[key] = true;
    else {
      const value = args[++index];
      requireValue(value && !value.startsWith("--"), "Missing option value");
      parsed[key] = value;
    }
  }
  const modes = [...switches].filter((key) => parsed[key]);
  requireValue(modes.length <= 1, "Conflicting modes");
  const mode = (modes[0]?.slice(2) ?? "dry-run") as CliOptions["mode"];
  requireValue(
    mode !== "self-test" || !parsed["--budget"],
    "Self-test uses its declared virtual budget; --budget is for dry-run planning or live admission",
  );
  requireValue(
    !parsed["--suite"] || parsed["--suite"] === "core24",
    "Only the frozen core24 suite is supported",
  );
  requireValue(
    mode !== "live" || typeof parsed["--budget"] === "string",
    "--live requires --budget before any startup or provider contact",
  );
  requireValue(!parsed["--lane"] || parsed["--lane"] === "container", "Unknown live lane");
  requireValue(
    parsed["--lane"] === "container" ||
      (!parsed["--container-report"] && !parsed["--container-cohort-approval"]),
    "Container cohort flags require --lane container",
  );
  requireValue(!parsed["--lane"] || mode === "live", "--lane selects the live lane only");
  requireValue(
    !parsed["--container-cohort-approval"] || parsed["--container-cohort-approval"] === "approved",
    "Container cohort approval must be the explicit value approved",
  );
  requireValue(
    parsed["--lane"] !== "container" ||
      !parsed["--expected-hermes-revision"] ||
      parsed["--expected-hermes-revision"] === HERMES_CONTAINER_REVISION,
    "The container cohort runs only the pinned Linux Hermes revision",
  );
  if (parsed["--expected-hermes-revision"])
    requireValue(
      /^[a-f0-9]{40}$/.test(String(parsed["--expected-hermes-revision"])),
      "Expected Hermes revision must be forty hex characters",
    );
  return {
    mode,
    suite: "core24",
    out: String(parsed["--out"] ?? `./artifacts/versus/${mode}`),
    budget: parsed["--budget"] as string | undefined,
    expectedRevision: parsed["--expected-hermes-revision"] as string | undefined,
    executable: parsed["--hermes-executable"] as string | undefined,
    source: parsed["--hermes-source"] as string | undefined,
    lane: parsed["--lane"] as "container" | undefined,
    containerReport: parsed["--container-report"] as string | undefined,
    approval: parsed["--container-cohort-approval"] as string | undefined,
  };
}
/** Test seams for the live lane. Omitted, the real image inspection and products run. */
export interface LiveDependencies {
  inspect?: typeof inspectImage;
  runTrials?: (input: { budget: Budget; plan: PairPlan[]; graderHash: string }) => Promise<LiveRun>;
}
export async function runCli(args: string[], live: LiveDependencies = {}) {
  const options = parseArguments(args);
  if (options.mode === "help") {
    console.log(HELP);
    return 0;
  }
  // Budget parsing precedes provenance, infrastructure and product imports.
  const budget = options.budget
    ? parseBudget(JSON.parse(await readFile(path.resolve(options.budget), "utf8")))
    : null;
  if (options.mode === "live" && options.lane === "container") {
    requireValue(budget, "Live budget missing");
    return runContainerLive(options, budget, live);
  }
  const hermes = await inspectHermes({
    executable: options.executable,
    source: options.source,
    expectedRevision: options.expectedRevision,
  });
  if (options.mode === "live") {
    requireValue(budget, "Live budget missing");
    requireValue(options.expectedRevision, "Live requires explicit --expected-hermes-revision");
    requireValue(
      hermes.identity.revisionMatches,
      "Hermes revision mismatch; select the actual approved cohort explicitly",
    );
  }
  const build = await inspectBuild();
  const cohort = budget?.cohort ?? {
    tasks: DEPARTMENT_TASKS.map((task) => task.id),
    repetitions: 1,
    history: "short" as const,
    cacheState: "not-measured",
  };
  const plan = planPairs(cohort);
  const prerequisites = [
    ...(hermes.identity.revisionMatches
      ? []
      : [
          `Hermes revision mismatch: expected ${hermes.identity.expectedRevision}, actual ${hermes.identity.actualRevision ?? "unavailable"}.`,
        ]),
    "Owner approval of endpoint, model digest/quantization/template/tokenizer and the complete finite budget file is required for live execution.",
    "The container release cohort requires its pinned Hermes image and final product/model qualification; stand-in probes do not qualify Hermes.",
    "Hard process-tree resource ceilings and detached-child accounting are not qualified on the native macOS lane.",
    "The container computer and pre-effect admission have explicit T0 gates; actual product/model settings and auxiliary routes still require final qualification.",
    "W0-3 and W0-4 collectors are landed; versus usage and full cross-product timing/paint coverage remain unqualified.",
    "The candidate model has not passed a tool round trip on both products. Metadata discovery alone cannot qualify it.",
  ];
  const launchPlan = {
    mode: options.mode,
    startsProducts: false,
    endpoint: budget?.endpoint ?? null,
    hermes: {
      executable: hermes.executable
        ? "<resolved-hermes-executable>"
        : "<missing-hermes-executable>",
      expectedRevision: options.expectedRevision ?? HERMES_RESEARCH_REVISION,
      argv: [
        "chat",
        "--query-file",
        "<trial-state>/query.txt",
        "--oneshot",
        "--provider",
        "custom",
        "--model",
        budget?.model.id ?? "<owner-approved-model>",
        "--reasoning",
        "none",
        "--max-turns",
        "12",
        "--run-budget",
        String((budget?.perTrial.wallMs ?? 600000) / 1000),
        "--in",
        "<trial-workspace>",
        "--no-restore-cwd",
        "--source",
        "versus",
        "--toolsets",
        "mcp-scoreboard",
      ],
      config: "new synthetic HERMES_HOME; no owner-state reads",
    },
    ardur: {
      route: "models/connect -> bots/create -> bots/update -> threads/send -> persisted terminal",
      stack: [
        "new PostgreSQL database",
        "API",
        "Graphile worker",
        "production executor",
        "isolated computer",
        "private MCP broker",
      ],
    },
    candidateModels: [
      "qwen3:8b",
      "qwen2.5-coder:7b",
      "llama3.1:8b",
      "qwen2.5-coder:32b",
      "gpt-oss:20b",
    ],
    candidateQualification: "not-run",
    prerequisites,
  };
  if (options.mode === "self-test") {
    const { runOfflineSelfTest } = await import("./self-test.js");
    const tested = await runOfflineSelfTest(plan, build.graderHash);
    await writeEvidence(path.resolve(options.out), {
      mode: "self-test",
      build,
      hermes: hermes.identity,
      plan,
      ...tested,
      prerequisites,
      launchPlan,
    });
    console.log(`Self-test retained ${tested.trials.length} T0 trials; real model calls: 0.`);
    return tested.protocolResults.passed && tested.trials.every((trial) => trial.grade.passed)
      ? 0
      : 1;
  }
  await writeEvidence(path.resolve(options.out), {
    mode: options.mode === "live" ? "dry-run" : options.mode,
    build,
    hermes: hermes.identity,
    plan,
    budget,
    trials: [],
    results: [],
    prerequisites,
    launchPlan,
  });
  if (options.mode === "live") {
    console.error(
      "Live refused before product/provider startup: native live stays unqualified; use --lane container for the approved container canary. Planning evidence was retained.",
    );
    return 2;
  }
  console.log(
    `Dry run complete; reports validated; real model calls: 0. Hermes revision match: ${hermes.identity.revisionMatches}.`,
  );
  return 0;
}
/** The approved container canary: gate, fixed-order trials, live evidence and a verdict. */
async function runContainerLive(options: CliOptions, budget: Budget, live: LiveDependencies) {
  const out = path.resolve(options.out);
  // A finished canary must never fail on its output directory, so check it before anything runs.
  const existing = await readdir(out).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw new Error(
      `Choose a new or empty --out directory; the one given could not be read (${error.code ?? "unknown error"}).`,
    );
  });
  requireValue(
    existing.length === 0,
    "Choose a new or empty --out directory; the one given already holds files.",
  );
  const gate = await assessLiveContainerGate({
    budget,
    approval: options.approval,
    reportPath: options.containerReport ? path.resolve(options.containerReport) : undefined,
    inspect: live.inspect,
  });
  const hermes = containerHermesIdentity(gate.pinnedImage);
  const build = await inspectBuild();
  const plan = planPairs(budget.cohort);
  const launchPlan = {
    mode: "live",
    lane: "separately-labeled-Linux-container-cohort",
    startsProducts: gate.ready,
    endpoint: budget.endpoint,
    order: plan.map((pair) => ({ pairId: pair.id, taskId: pair.taskId, order: pair.order })),
    hermes: { image: gate.pinnedImage?.id ?? null, revision: HERMES_CONTAINER_REVISION },
    ardur: {
      route: "models/connect -> bots/create -> bots/update -> threads/send -> persisted terminal",
      computer: "confined Linux container computer",
    },
    gate: { stage: gate.stage, gates: gate.gates, ready: gate.ready },
  };
  const planning = (prerequisites: string[]) =>
    writeEvidence(out, {
      mode: "dry-run",
      build,
      hermes,
      plan,
      budget,
      trials: [],
      results: [],
      prerequisites,
      launchPlan,
    });
  if (!gate.ready) {
    await planning(gate.failures);
    console.error(
      `Live refused before product start${gate.stage === "offline" ? " or endpoint contact" : " or any model request"}: ${gate.failures.join("; ")}. Planning evidence was retained.`,
    );
    return 2;
  }
  const input = { budget, plan, graderHash: build.graderHash };
  let run: LiveRun;
  try {
    run = live.runTrials
      ? await live.runTrials(input)
      : await (await import("./live-products.js")).runLiveChild(input);
  } catch (error) {
    const failure = sanitize(error instanceof Error ? error.message : String(error));
    await planning([`The live run did not finish: ${failure}`]);
    console.error(`Live run incomplete: ${failure}. Planning evidence was retained.`);
    return 2;
  }
  const sourceUnchangedDuringRun =
    contentDigest(build.build) === contentDigest((await inspectBuild()).build);
  try {
    await writeEvidence(out, {
      mode: "live",
      build,
      hermes,
      plan,
      budget,
      trials: run.trials,
      results: run.results,
      prerequisites: [
        ...(sourceUnchangedDuringRun ? [] : ["Harness source changed during the run."]),
        "Metadata attestation cannot prove the OpenAI-compatible transport served the declared context.",
        "Request purposes are not observed at the gateway; usage stays raw and is not relabeled as main.",
        "Resource, timing and paint coverage for either product remain unmeasured.",
      ],
      launchPlan,
      budgetEvidence: run.budgetEvidence,
      protocolResults: { ...run.protocolResults, sourceUnchangedDuringRun },
    });
  } catch (error) {
    const failure = sanitize(error instanceof Error ? error.message : String(error));
    const saved = await saveUnwrittenRun(out, {
      failure,
      build: build.build,
      hermes,
      budget,
      plan,
      run,
    });
    console.error(
      `The live evidence could not be written or validated (${failure}); the finished run was saved to ${saved}. Keep that file and write its evidence from it; do not rerun the canary.`,
    );
    return 2;
  }
  const verdict = liveVerdict(run);
  console.log(verdict.summary);
  return sourceUnchangedDuringRun ? verdict.code : 2;
}
/** Saves a finished run whose evidence could not be written: beside --out, else a named folder. */
async function saveUnwrittenRun(out: string, value: unknown) {
  const name = `${path.basename(out)}.unwritten-run-${Date.now()}.json`;
  const bytes = `${JSON.stringify(value)}\n`;
  for (const folder of [path.dirname(out), path.join(tmpdir(), "versus-live-unwritten-runs")])
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(path.join(folder, name), bytes, { flag: "wx", mode: 0o600 });
      return path.join(folder, name);
    } catch {
      /* Try the next folder. */
    }
  throw new Error("The finished run could not be saved anywhere; its evidence is lost.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(sanitize(error instanceof Error ? error.message : "Versus command failed"));
      process.exitCode = 2;
    });
}
