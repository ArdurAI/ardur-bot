import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEPARTMENT_TASKS } from "../scoreboard/tasks/catalog.js";
import { parseBudget, requireValue } from "./budget.js";
import { writeEvidence } from "./evidence.js";
import { HERMES_RESEARCH_REVISION } from "./manifest.js";
import { inspectBuild, inspectHermes, sanitize } from "./provenance.js";
import { planPairs } from "./scheduler.js";

export const HELP = `Ardur Bot versus Hermes benchmark

pnpm --filter @ardurbot/testkit exec tsx src/versus/cli.ts --dry-run --suite core24 --out ./artifacts/versus/dry
pnpm --filter @ardurbot/testkit exec tsx src/versus/cli.ts --self-test --out ./artifacts/versus/self-test
pnpm --filter @ardurbot/testkit exec tsx src/versus/cli.ts --live --budget ./budget.json --suite core24 --expected-hermes-revision <approved-40-hex-revision> --out ./artifacts/versus/live

Optional: --hermes-executable <path> --hermes-source <path>
No arguments prints help. Dry run performs no network or product startup.
Self-test uses synthetic loopback providers and scripted product doubles.
Live requires finite budgets and all route/isolation qualification gates.
`;
export interface CliOptions {
  mode: "dry-run" | "self-test" | "live" | "help";
  suite: "core24";
  out: string;
  budget?: string;
  expectedRevision?: string;
  executable?: string;
  source?: string;
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
  };
}
export async function runCli(args: string[]) {
  const options = parseArguments(args);
  if (options.mode === "help") {
    console.log(HELP);
    return 0;
  }
  // Budget parsing precedes provenance, infrastructure and product imports.
  const budget = options.budget
    ? parseBudget(JSON.parse(await readFile(path.resolve(options.budget), "utf8")))
    : null;
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
      "Live refused before product/provider startup: the pinned container release and shared-model/auxiliary-route qualification remain incomplete. Planning evidence was retained.",
    );
    return 2;
  }
  console.log(
    `Dry run complete; reports validated; real model calls: 0. Hermes revision match: ${hermes.identity.revisionMatches}.`,
  );
  return 0;
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
