import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { tsImport } from "tsx/esm/api";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Historical summaries remain diagnostic: they cannot establish paired release evidence. */
export function legacyTimingVerdict(before, after) {
  const reasons = [];
  const warnings = [];
  const invalid = (code, detail) => reasons.push({ code, scope: "legacy", detail });
  if (
    !isRecord(before) ||
    !isRecord(after) ||
    !["offline-proxy", "browser-proxy"].includes(before.kind) ||
    before.kind !== after.kind
  ) {
    invalid("unsupported-legacy-kind", "Expected matching known proxy reports.");
  } else if (
    !isRecord(before.machine) ||
    !Object.keys(before.machine).length ||
    !isRecord(after.machine) ||
    !isDeepStrictEqual(before.machine, after.machine)
  ) {
    invalid("environment-mismatch", "Timing environments differ; collect a comparable baseline.");
  }
  if (
    !isRecord(before?.metrics) ||
    !isRecord(after?.metrics) ||
    !Object.keys(before.metrics).length ||
    Object.keys(before.metrics).sort().join(",") !== Object.keys(after.metrics).sort().join(",")
  ) {
    invalid("metric-key-mismatch", "A nonempty identical timing metric set is required.");
  } else {
    for (const [metric, value] of Object.entries(before.metrics)) {
      const current = after.metrics[metric];
      if (!Number.isFinite(value) || value < 0 || !Number.isFinite(current) || current < 0)
        invalid("invalid-value", `Missing or invalid timing: ${metric}.`);
      else if (current - value > Math.max(value * 0.05, 25))
        warnings.push(`${metric} exceeds the proposed 5% and 25 ms advisory margin.`);
    }
  }
  for (const report of [before, after]) {
    if (isRecord(report) && "samples" in report) {
      const valid =
        report.kind === "browser-proxy" && Array.isArray(report.samples)
          ? report.samples.length > 0 &&
            report.samples.every((value) => Number.isFinite(value) && value >= 0)
          : Number.isSafeInteger(report.samples) && report.samples > 0;
      if (!valid)
        invalid(
          "invalid-sample-count",
          "Sample count must be positive and any raw samples must be finite nonnegative durations.",
        );
    }
  }
  reasons.push({
    code: "legacy-unpaired-summary",
    scope: "legacy",
    detail:
      "Historical summaries lack paired raw evidence, calibrated policy and fixed-release provenance.",
  });
  return { status: "incomplete", exitCode: 2, reasons, warnings };
}

export function timingWarnings(before, after) {
  const result = legacyTimingVerdict(before, after);
  return [
    ...result.reasons
      .filter((reason) => reason.code !== "legacy-unpaired-summary")
      .map((reason) => reason.detail),
    ...result.warnings,
  ];
}

// The established CLI is plain Node. tsImport uses the repository's existing TS runtime
// only for schema readers and analysis, without making legacy callers change launchers.
export async function performanceVerdict({ parent, candidate, fixedRelease, policy }) {
  if (parent?.kind || candidate?.kind) return legacyTimingVerdict(parent, candidate);
  if (
    parent?.schemaVersion === 1 ||
    parent?.schemaVersion === 2 ||
    candidate?.schemaVersion === 1 ||
    candidate?.schemaVersion === 2
  ) {
    const { readPerformanceReport } = await tsImport(
      "../packages/testkit/src/performance-report.ts",
      import.meta.url,
    );
    try {
      readPerformanceReport(parent, "parent");
      readPerformanceReport(candidate, "candidate");
      return {
        status: "incomplete",
        exitCode: 2,
        reasons: [
          {
            code: "legacy-unpaired-summary",
            scope: "reports",
            detail:
              "Historical desktop summaries are readable but cannot satisfy schema-3 release evidence.",
          },
        ],
        warnings: [],
      };
    } catch {
      return {
        status: "incomplete",
        exitCode: 2,
        reasons: [{ code: "invalid-legacy-report", scope: "reports" }],
        warnings: [],
      };
    }
  }
  const { comparePerformanceEvidence } = await tsImport(
    "../packages/testkit/src/scoreboard/statistics.ts",
    import.meta.url,
  );
  return comparePerformanceEvidence({ parent, candidate, fixedRelease, policy });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let result;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 && args.length !== 4) throw new Error("arguments");
    const [parent, candidate, fixedRelease, policy] = await Promise.all(
      args.map(async (file) => JSON.parse(await readFile(file, "utf8"))),
    );
    result = await performanceVerdict({ parent, candidate, fixedRelease, policy });
  } catch {
    result = {
      status: "incomplete",
      exitCode: 2,
      reasons: [
        {
          code: "invalid-input",
          scope: "cli",
          detail:
            "Expected readable JSON: performance-budget.mjs parent.json candidate.json [fixed-release.json policy.json].",
        },
      ],
      warnings: [],
    };
  }
  console.log(JSON.stringify(result, null, 2));
  console.error(
    `Performance budget: ${result.status}; ${result.reasons.length} reason(s). Development checks remain advisory.`,
  );
  process.exitCode = result.exitCode;
}
