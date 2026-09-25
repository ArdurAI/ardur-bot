import { contentDigest, SCOREBOARD_MANIFEST } from "../scoreboard/manifest.js";
import { DEPARTMENT_TASKS, immutable } from "../scoreboard/tasks/catalog.js";
import { taskMaterial } from "../scoreboard/tasks/variants.js";

export const HERMES_RESEARCH_REVISION = "693641aa8b4359c602283bdbbc14041e03bc47bc";
export const HERMES_RELEASE_REVISION = "29112bef099274229cadff79cdff7bf7b99c4b77";
export const RESEARCH_BASELINE = "9d4fbe89f38b09d7080f4d45e1fa8ce2fc351330";
export const ANALYSIS_SEED = 20260924;
export const PRODUCTS = ["ardur", "hermes"] as const;
export type Product = (typeof PRODUCTS)[number];
export const PARITY_TASKS = immutable(
  [
    ["H01", "Memory across sessions and profiles", "trajectory", 20],
    ["H02", "Learn, transfer, undo", "trajectory", 20],
    ["H03", "Cron continuity", "scenario", 20],
    ["H04", "Remote control", "operation-channel", 20],
    ["H05", "Child lifecycle", "scenario", 20],
    ["H06", "MCP lifecycle", "scenario", 20],
    ["H07", "Computer and workspace boundary", "backend-scenario", 20],
    ["H08", "Interrupted effect", "crash-boundary", 20],
    ["H09", "Hostile retrieved material", "attack-template", 60],
    ["H10", "Cold start and default egress", "startup-stratum", 100],
    ["H11", "Persistent computation", "scenario", 20],
    ["H12", "Honest native route", "route-scenario", 20],
  ].map(([id, name, cluster, proposedIndependentSamples]) => ({
    id,
    name,
    cluster,
    proposedIndependentSamples,
  })),
);

export const VERSUS_PROTOCOL = immutable({
  version: 1,
  scoreboardManifestHash: contentDigest(SCOREBOARD_MANIFEST),
  products: PRODUCTS,
  analysisSeed: ANALYSIS_SEED,
  comparisonMode: "controlled-harness",
  learning: "disabled-fixed-single-session",
  order: "serial-paired-seeded-shuffle",
  invalidInfrastructure: "retain-in-denominator-no-automatic-replacement",
  claims: ["quality", "latency", "logical-input", "cost"],
  correction: "bonferroni-across-four-claims-and-seven-quality-guards",
  qualityMargin: 0.05,
  efficiencyRatio: 0.8,
  minimumIndependentPairs: 20,
  parity: PARITY_TASKS,
  extensionAdapters: ["prime-agent", "claude-code-direct", "codex-direct"],
});

/** Inputs only: grader implementations are never part of a task material tree. */
export function frozenInputs(history: "short" | "long" = "short") {
  return DEPARTMENT_TASKS.map((task) => {
    const material = taskMaterial(task, { history, tools: "local", capacity: 16000 });
    return {
      taskId: task.id,
      department: task.department,
      hash: contentDigest(material),
      material,
    };
  });
}
