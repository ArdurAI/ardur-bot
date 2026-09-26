import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

/** Local historical scoreboard. Workflow artifacts are a transport copy, not this store. */
export const SCOREBOARD_INDEX_RELATIVE_PATH = ".context/performance/scoreboard-index";
export const INDEX_SCHEMA_VERSION = 7;
export const WORKFLOW_ARTIFACT_RETENTION_DAYS = 90;
/** Changing the committed release policy is a reviewed change to this digest. */
export const RELEASE_POLICY_SHA256 =
  "dbc81d2cd48aae6ddd5ec7c5fde042f6219cf89fd9610a59e5ed1df4c2e55a0e";
const RELEASE_POLICY_FILE = fileURLToPath(
  new URL("../docs/performance/release-policy.json", import.meta.url),
);
/** The record schema version is part of the artifact name, so a schema bump never restores
 * records the current code cannot read; it starts a fresh chain instead. */
const INDEX_ARTIFACT = `scoreboard-index-schema-${INDEX_SCHEMA_VERSION}`;
const RELEASE_INDEX_ARTIFACT = `scoreboard-release-index-schema-${INDEX_SCHEMA_VERSION}`;
/**
 * Each durable chain is restored from the newest live artifact its own workflow uploaded. A
 * refused release still uploads its chain, so any completed release run counts.
 */
const INDEX_SCOPES = {
  commit: {
    workflow: "performance.yml",
    artifact: INDEX_ARTIFACT,
    otherSchema: /^scoreboard-index-schema-\d+$/,
    events: ["push"],
    status: "success",
    marker: { file: "scripts/scoreboard-index.mjs", text: null },
  },
  release: {
    workflow: "release-desktop.yml",
    artifact: RELEASE_INDEX_ARTIFACT,
    otherSchema: /^scoreboard-release-index-schema-\d+$/,
    events: ["push", "workflow_dispatch"],
    status: "completed",
    // A schema-versioned artifact name never appears literally in the workflow text, so this
    // marker names a stable step instead of the artifact.
    marker: { file: ".github/workflows/performance.yml", text: "prior-index --scope release" },
  },
};
const CHAIN_ORIGINS = [
  "first-run",
  "expired-after-90-days-inactivity",
  "prior-artifact-missing",
  "non-durable-check",
  "history-rewritten",
  "schema-upgrade",
  "restore-failed",
];
const ENUMERATION_REASONS = ["empty-chain-retention-window", "chain-without-ancestor"];
/** The release evidence run must produce both reports for the same commit and build. */
const GUARDRAIL_REPORTS = {
  "effect-safety": { tier: "T1", label: "T1 durable crash report" },
  "deterministic-tasks": { tier: "T1", label: "T1 durable crash report" },
  recovery: { tier: "T1", label: "T1 durable crash report" },
  "prompt-tokens": { tier: "T1", label: "T1 durable crash report" },
  "cache-compaction": { tier: "T1", label: "T1 durable crash report" },
  latency: { tier: "T2", label: "T2 startup strata report" },
  "absolute-targets": { tier: "T2", label: "T2 startup strata report" },
  bundle: { tier: "T2", label: "T2 startup strata report" },
  memory: { tier: "T2", label: "T2 startup strata report" },
  energy: { tier: "T2", label: "T2 startup strata report" },
};
export const REQUIRED_RELEASE_TARGETS = Object.freeze([
  "desktop-darwin-arm64",
  "desktop-darwin-x64",
  "desktop-linux-x64",
  "desktop-win32-x64",
]);
export const PENDING_REASONS = Object.freeze([
  "not-measured",
  "benchmark-runner-incompatible",
  "schema-3-evidence-not-produced",
  "reports-missing",
  "infrastructure-unavailable",
  "artifact-digest-mismatch",
  "missing-energy",
  "missing-platform",
  "insufficient-samples",
  "insufficient-startup-samples",
  "tier-not-releasable",
  "missing-fixed-release",
  "release-commit-mismatch",
  "unmapped-artifact",
  "mandatory-evidence-unknown",
  "undeclared-budget",
  "outcome-pairing-changed",
  "incomplete-analysis",
  "invalid-policy",
  "invalid-evidence",
  "incomplete-evidence",
  "baseline-commit-mismatch",
  "calibration-required",
  "candidate-before-policy-freeze",
  "incomparable-evidence",
  "inconclusive-interval",
]);
const GENESIS = "0".repeat(64);
export const RECORD_KEYS = [
  "schemaVersion",
  "status",
  "tier",
  "commit",
  "parentCommit",
  "fixedReleaseCommit",
  "suiteVersion",
  "suiteHash",
  "environment",
  "environmentHash",
  "attempt",
  "role",
  "indexedAt",
  "runnerCommit",
  "samplePlan",
  "declaredSamples",
  "observedSamples",
  "reportDigest",
  "objectDigest",
  "verdictDigest",
  "artifactDigests",
  "pendingReason",
  "gateCodes",
  "supersedes",
  "chainOrigin",
  "enumerationStart",
  "enumerationReason",
  "waiver",
  "metricIds",
  "previousHash",
];
const DIRECTORY_TARGETS = {
  "desktop-mac-arm64": "desktop-darwin-arm64",
  "desktop-mac-x64": "desktop-darwin-x64",
  "desktop-linux-x64": "desktop-linux-x64",
  "desktop-linux-arm64": "desktop-linux-arm64",
  "desktop-win-x64": "desktop-win32-x64",
};
const TARGET_PLATFORM = {
  "desktop-darwin-arm64": "darwin",
  "desktop-darwin-x64": "darwin",
  "desktop-linux-x64": "linux",
  "desktop-linux-arm64": "linux",
  "desktop-win32-x64": "win32",
};
export const REFUSAL_CODES = new Set([
  "safety-failure",
  "budget-regression",
  "required-task-failed",
  "release-policy-unpinned",
  "release-policy-mismatch",
  "waiver-not-permitted",
  "invalid-waiver",
  "waiver-with-evidence",
  "invalid-energy-entry",
  "unjudged-report",
]);
/** Plain names for budgets that need a reviewed declaration before they can be checked. */
const BUDGET_NAMES = {
  "m10.post-idle-retained": "retained session growth",
  "m13.terminal-stop": "tool termination deadline",
};
const FAILURE_EXIT_CODES = new Set([
  ...REFUSAL_CODES,
  "artifact-digest-mismatch",
  "unmapped-artifact",
]);
const REPORT_FILES = ["parent.json", "candidate.json", "fixed-release.json", "policy.json"];
const PRIVATE_MARKERS = [
  "/Users/",
  "/home/",
  "/private/",
  "/var/",
  "/tmp/",
  "file://",
  "C:\\",
  "\\\\",
  "~",
];

export class ScoreboardIndexError extends Error {
  constructor(code, detail = code) {
    super(detail);
    this.name = "ScoreboardIndexError";
    this.code = code;
  }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

let loaded;
function loadScoreboard() {
  loaded ??= Promise.all([
    tsImport("../packages/testkit/src/scoreboard/manifest.ts", import.meta.url),
    tsImport("../packages/testkit/src/performance-report.ts", import.meta.url),
    tsImport("../packages/testkit/src/scoreboard/statistics.ts", import.meta.url),
    tsImport("../packages/testkit/src/scoreboard/packaged/plan.ts", import.meta.url),
    tsImport("../packages/testkit/src/scoreboard/resources/artifacts.ts", import.meta.url),
    tsImport("../packages/testkit/src/scoreboard/resources/energy.ts", import.meta.url),
  ]).then(([manifest, report, statistics, plan, artifacts, energy]) => ({
    canonicalSerialize: manifest.canonicalSerialize,
    contentDigest: manifest.contentDigest,
    SCOREBOARD_MANIFEST: manifest.SCOREBOARD_MANIFEST,
    suiteHash: manifest.contentDigest(manifest.SCOREBOARD_MANIFEST),
    createPerformanceEvidenceEnvelope: report.createPerformanceEvidenceEnvelope,
    parsePerformanceEvidenceEnvelope: report.parsePerformanceEvidenceEnvelope,
    assertRequiredEvidence: report.assertRequiredEvidence,
    comparePerformanceEvidence: statistics.comparePerformanceEvidence,
    judgeReport: statistics.judgeReport,
    reportRules: statistics.reportRules,
    SAFETY_METRICS: statistics.SAFETY_METRICS,
    createBudgetPolicy: statistics.createBudgetPolicy,
    freezeBudgetPolicy: statistics.freezeBudgetPolicy,
    metricBudget: statistics.metricBudget,
    METRIC_DEFINITIONS: manifest.METRIC_DEFINITIONS,
    packagedCoverage: plan.packagedCoverage,
    RELEASE_TARGETS: plan.RELEASE_TARGETS,
    STARTUP_STRATA: plan.STARTUP_STRATA,
    inventoryArtifact: artifacts.inventoryArtifact,
    ingestPhysicalEnergy: energy.ingestPhysicalEnergy,
  }));
  return loaded;
}

function fail(code, detail) {
  throw new ScoreboardIndexError(code, detail ?? code);
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, keys, code = "invalid-record") {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
    fail(code, code);
}
function sha40(value, code = "invalid-commit") {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) fail(code, code);
}
function digest(value, code = "invalid-digest") {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(code, code);
}
function opaque(value, code = "invalid-label") {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value) || value.includes(".."))
    fail(code, code);
}
function timestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  )
    fail("invalid-timestamp", "invalid-timestamp");
}
function assertPublicValue(value) {
  if (typeof value === "string") {
    if (PRIVATE_MARKERS.some((marker) => value.includes(marker)) || /^[A-Za-z]:\\/.test(value))
      fail("private-data", "private-data");
    if (
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(value) ||
      /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+@/.test(value)
    )
      fail("private-data", "private-data");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertPublicValue(item);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) assertPublicValue(item);
  }
}

/**
 * Waiver text lands in public release notes, so it stays one plain sentence without markup, and
 * without a path, host or URL: any token with a slash is a path or a schemeless URL, and any
 * `www.` token is a host, even without a scheme or a slash.
 */
function parseWaiverReason(reason) {
  if (typeof reason !== "string") return null;
  const text = reason.trim().replace(/\.+$/, "").trim();
  if (
    !/^[A-Za-z0-9 .,;:'"()!?&%+/-]{1,200}$/.test(text) ||
    !/[A-Za-z]/.test(text) ||
    text.includes("://") ||
    text.split(/\s+/).some((token) => token.includes("/") || /^www\./i.test(token))
  )
    return null;
  try {
    assertPublicValue(text);
  } catch {
    return null;
  }
  return text;
}

/** The dispatching account is kept in the index record only, never in a public release asset. */
function parseEvidenceWaiver(reason, actor) {
  const text = parseWaiverReason(reason);
  if (
    text === null ||
    typeof actor !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/.test(actor)
  )
    return null;
  return { reason: text, actor };
}

async function loadReleasePolicy(file, expectedSha256) {
  const scoreboard = await loadScoreboard();
  try {
    const bytes = await readFile(file);
    const digestValue = sha256(bytes);
    if (digestValue !== expectedSha256) return null;
    const policy = JSON.parse(bytes.toString("utf8"));
    exactKeys(policy, [
      "schemaVersion",
      "suiteVersion",
      "manifestHash",
      "releaseTargets",
      "budget",
      "guardrails",
    ]);
    exactKeys(policy.budget, ["mode", "required", "declarations", "seed", "resamples"]);
    if (
      policy.schemaVersion !== 1 ||
      policy.suiteVersion !== scoreboard.SCOREBOARD_MANIFEST.suiteVersion ||
      policy.manifestHash !== scoreboard.suiteHash ||
      policy.budget.mode !== "release" ||
      policy.releaseTargets.join(",") !== REQUIRED_RELEASE_TARGETS.join(",") ||
      !Array.isArray(policy.guardrails) ||
      !policy.guardrails.length
    )
      return null;
    for (const guardrail of policy.guardrails) {
      exactKeys(guardrail, [
        "id",
        "metricIds",
        "taskIds",
        "experimentIds",
        "crashBoundaryIds",
        "usage",
      ]);
      opaque(guardrail.id);
    }
    return { sha256: digestValue, policy };
  } catch {
    return null;
  }
}

function suppliedPolicyMatches(releasePolicy, supplied, canonicalSerialize) {
  try {
    const { policy } = supplied;
    return (
      canonicalSerialize({
        manifestHash: policy.manifestHash,
        mode: policy.mode,
        required: policy.required,
        declarations: policy.declarations,
        seed: policy.analysis.seed,
        resamples: policy.analysis.resamples,
      }) ===
      canonicalSerialize({ manifestHash: releasePolicy.manifestHash, ...releasePolicy.budget })
    );
  } catch {
    return false;
  }
}

function sameKey(record, key) {
  return (
    record.commit === key.commit &&
    record.suiteHash === key.suiteHash &&
    record.environment === key.environment &&
    record.role === key.role &&
    record.tier === key.tier
  );
}
function recordsPath(root) {
  return path.join(root, "records.jsonl");
}
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
async function directoryHasEntries(directory) {
  try {
    return (await readdir(directory)).length > 0;
  } catch {
    return false;
  }
}

/** A run that does not extend a durable chain indexes only its own commits: base to head, or head. */
export function selectCommitRange({ base, head }) {
  sha40(head);
  if (base && base !== "0".repeat(40)) {
    sha40(base);
    return { kind: "range", base, head };
  }
  return { kind: "single", head };
}

export function parseRevListParents(text) {
  if (typeof text !== "string") fail("invalid-rev-list", "invalid-rev-list");
  const commits = [];
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [commit, parentCommit] = line.split(" ");
    sha40(commit);
    if (parentCommit) sha40(parentCommit);
    if (seen.has(commit)) fail("duplicate-commit", "duplicate-commit");
    seen.add(commit);
    commits.push({ commit, parentCommit: parentCommit || null });
  }
  return commits;
}

export function baselineMeasurementPlan({ baseHarnessPresent, candidateSha, baseSha }) {
  sha40(candidateSha);
  sha40(baseSha);
  if (typeof baseHarnessPresent !== "boolean") fail("invalid-harness", "invalid-harness");
  const pendingReason = baseHarnessPresent ? null : "benchmark-runner-incompatible";
  return {
    measureBaseline: pendingReason === null,
    pendingReason,
  };
}

/**
 * `pendingReason` is the budgets job's verdict for `headCommit` alone. A commit reached only by
 * backfill or by a multi-commit push was never individually attempted, so it is `not-measured`.
 * With no `headCommit`, every commit uses `pendingReason`, for callers that plan a single
 * attempted commit. No caller can supply an actual measurement for a commit-tier push today, so
 * every planned commit is `pending`, never `measured`.
 */
export function planEvidenceRecords({ commits, pendingReason, headCommit = null }) {
  if (!Array.isArray(commits)) fail("invalid-commits", "invalid-commits");
  if (!PENDING_REASONS.includes(pendingReason)) fail("invalid-reason", "invalid-reason");
  const seen = new Set();
  return commits.map((commit) => {
    sha40(commit?.commit);
    if (commit.parentCommit !== null) sha40(commit.parentCommit);
    if (seen.has(commit.commit)) fail("duplicate-commit", "duplicate-commit");
    seen.add(commit.commit);
    const attempted = headCommit === null || commit.commit === headCommit;
    return {
      commit: commit.commit,
      parentCommit: commit.parentCommit,
      pendingReason: attempted ? pendingReason : "not-measured",
    };
  });
}

export async function samplePlanFor(mode) {
  const { SCOREBOARD_MANIFEST } = await loadScoreboard();
  const plan = SCOREBOARD_MANIFEST.samplePlan;
  if (mode === "commit")
    return {
      label: "commit-short",
      declaredSamples: { pairs: plan.commitPairs, startupPerStratum: null },
    };
  if (mode === "release")
    return {
      label: "release-grade",
      declaredSamples: {
        pairs: plan.releaseReplayPairs,
        startupPerStratum: plan.releaseStartupObservationsPerStratum,
      },
    };
  fail("invalid-mode", "invalid-mode");
}

/**
 * Every writer of one index root runs as a single step of a single job on its own runner; no two
 * processes ever hold this lock at once in production. The lock exists only to fail loudly if
 * that assumption is ever wrong (or a test deliberately races), so it is a plain mutex with a
 * timeout and no heartbeat or stale-lock takeover.
 */
async function withIndexLock(root, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  await mkdir(root, { recursive: true });
  const lockDir = path.join(root, "lock");
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - started > timeoutMs)
        fail("lock-timeout", "Scoreboard index lock timed out.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function hashRecord(body, contentDigest) {
  const unsigned = { ...body };
  delete unsigned.recordHash;
  return contentDigest(unsigned);
}

async function readIndexUnlocked(root) {
  const { contentDigest } = await loadScoreboard();
  const file = recordsPath(root);
  if (!(await exists(file))) return [];
  const text = await readFile(file, "utf8");
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) fail("corrupt-index", "corrupt-index");
  const records = [];
  let previous = GENESIS;
  for (const line of text.slice(0, -1).split("\n")) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail("corrupt-index", "corrupt-index");
    }
    if (record?.schemaVersion !== INDEX_SCHEMA_VERSION)
      fail(
        "unsupported-index-schema",
        `Index records must use schema version ${INDEX_SCHEMA_VERSION}.`,
      );
    exactKeys(record, [...RECORD_KEYS, "recordHash"]);
    const actual = hashRecord(record, contentDigest);
    if (record.recordHash !== actual || record.previousHash !== previous)
      fail("corrupt-index", "corrupt-index");
    digest(record.recordHash);
    previous = record.recordHash;
    records.push(record);
  }
  return records;
}

export async function readIndex(root) {
  return withIndexLock(root, () => readIndexUnlocked(root));
}

export function nextAttempt(records, key) {
  return (
    records
      .filter((record) => sameKey(record, key))
      .reduce((max, record) => Math.max(max, record.attempt), 0) + 1
  );
}

export function auditCommits(records, commits) {
  const results = commits.map((commit) => {
    const id = typeof commit === "string" ? commit : commit.commit;
    sha40(id);
    const history = records.filter((record) => record.commit === id && record.role === "candidate");
    const measured = history.filter((record) => record.status === "measured");
    const pending = history.filter((record) => record.status === "pending");
    const current = measured.at(-1) ?? pending.at(-1) ?? null;
    return {
      commit: id,
      status: current?.status ?? "missing",
      history: history.length,
      rejections: history.filter((record) => record.status === "rejected").length,
    };
  });
  return {
    complete: results.every(
      (result) => result.status === "measured" || result.status === "pending",
    ),
    measured: results.filter((result) => result.status === "measured").length,
    pending: results.filter((result) => result.status === "pending").length,
    missing: results.filter((result) => result.status === "missing").map((result) => result.commit),
    results,
  };
}

async function putObject(root, bytes) {
  const digestValue = sha256(bytes);
  const directory = path.join(root, "objects");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, digestValue);
  try {
    await writeFile(file, bytes, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const current = await readFile(file);
    if (!current.equals(Buffer.from(bytes))) fail("object-collision", "object-collision");
  }
  return digestValue;
}

function artifactName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,180}$/.test(name) || name.includes(".."))
    fail("unsafe-artifact-name", "unsafe-artifact-name");
}

function storedGateCodes(values, required) {
  const codes = Array.isArray(values) ? values : [];
  if (
    (required && codes.length === 0) ||
    codes.some((code) => typeof code !== "string" || !/^[a-z0-9-]+$/.test(code))
  )
    fail("invalid-gate-codes", "invalid-gate-codes");
  return [...new Set(codes)].sort();
}

function storedMetricIds(values) {
  const ids = Array.isArray(values) ? values : [];
  if (ids.some((id) => typeof id !== "string" || !/^[a-z][a-z0-9.-]*$/.test(id)))
    fail("invalid-metric-id", "invalid-metric-id");
  return [...new Set(ids)].sort();
}

export function classifyGateCodes(codes) {
  const unique = [...new Set(codes)].sort();
  for (const code of unique) {
    const pending = PENDING_REASONS.includes(code);
    const refusal = REFUSAL_CODES.has(code);
    if (pending === refusal) fail("unknown-gate-code", `unknown-gate-code: ${code}`);
  }
  return unique;
}

function metricIdsFromReasons(reasons) {
  return storedMetricIds(
    reasons
      .filter((reason) => reason.code === "undeclared-budget")
      .map((reason) =>
        String(reason.scope ?? "")
          .split(":")
          .at(-1),
      ),
  );
}

function pendingReasonFor(reasons) {
  const codes = reasons.map((reason) => reason.code);
  if (codes.includes("undeclared-budget")) return "undeclared-budget";
  const first = codes[0];
  return PENDING_REASONS.includes(first) ? first : "reports-missing";
}

function storedArtifacts(values, releaseTargets) {
  const stored = (Array.isArray(values) ? values : []).map((artifact) => {
    exactKeys(artifact, ["name", "sha256", "bytes", "target"], "unsafe-artifact-name");
    artifactName(artifact.name);
    digest(artifact.sha256);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0)
      fail("invalid-digest", "invalid-digest");
    if (artifact.target !== null && !releaseTargets.includes(artifact.target))
      fail("unknown-target", "unknown-target");
    return {
      name: artifact.name,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      target: artifact.target,
    };
  });
  return stored.sort((left, right) =>
    left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0,
  );
}

async function normalizeRecord(input, existing) {
  const scoreboard = await loadScoreboard();
  const publicInput = { ...input };
  delete publicInput.root;
  assertPublicValue(publicInput);
  opaque(input.environment);
  opaque(input.suiteVersion);
  if (input.suiteVersion !== scoreboard.SCOREBOARD_MANIFEST.suiteVersion)
    fail("unsupported-suite", "unsupported-suite");
  const suiteHash = scoreboard.suiteHash;
  sha40(input.commit);
  if (input.parentCommit !== null) sha40(input.parentCommit);
  if (input.fixedReleaseCommit !== null) sha40(input.fixedReleaseCommit);
  sha40(input.runnerCommit);
  timestamp(input.indexedAt);
  if (!["measured", "pending", "rejected", "refused", "waived"].includes(input.status))
    fail("invalid-status", "invalid-status");
  if (!["commit", "release"].includes(input.tier)) fail("invalid-tier", "invalid-tier");
  if (input.status === "waived" && input.tier !== "release")
    fail("invalid-status", "invalid-status");
  if (input.status !== "waived" && input.waiver != null) fail("invalid-record", "invalid-record");
  if (!["candidate", "parent", "fixed-release"].includes(input.role))
    fail("invalid-role", "invalid-role");
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1)
    fail("attempt-conflict", "attempt-conflict");
  const plan = await samplePlanFor(input.mode);
  if (input.environmentHash !== null) digest(input.environmentHash);
  const body = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    status: input.status,
    tier: input.tier,
    commit: input.commit,
    parentCommit: input.parentCommit,
    fixedReleaseCommit: input.fixedReleaseCommit,
    suiteVersion: input.suiteVersion,
    suiteHash,
    environment: input.environment,
    environmentHash: input.environmentHash,
    attempt: input.attempt,
    role: input.role,
    indexedAt: input.indexedAt,
    runnerCommit: input.runnerCommit,
    samplePlan: plan.label,
    declaredSamples: plan.declaredSamples,
    observedSamples: null,
    reportDigest: null,
    objectDigest: null,
    verdictDigest: null,
    artifactDigests: [],
    pendingReason: null,
    gateCodes: [],
    metricIds: storedMetricIds(input.metricIds),
    supersedes: input.supersedes,
    chainOrigin: existing.length === 0 ? (input.chainOrigin ?? "first-run") : null,
    enumerationStart: input.enumerationStart ?? null,
    enumerationReason: input.enumerationReason ?? null,
    waiver: null,
    previousHash: existing.at(-1)?.recordHash ?? GENESIS,
  };
  if (body.chainOrigin !== null && !CHAIN_ORIGINS.includes(body.chainOrigin))
    fail("invalid-chain-origin", "invalid-chain-origin");
  if (body.enumerationStart !== null) sha40(body.enumerationStart);
  if (body.enumerationReason !== null && !ENUMERATION_REASONS.includes(body.enumerationReason))
    fail("invalid-record", "invalid-record");
  if ((body.enumerationStart === null) !== (body.enumerationReason === null))
    fail("invalid-record", "invalid-record");
  const prior = existing.filter((record) => sameKey(record, body));
  if (body.status === "pending" && prior.some((record) => record.status === "measured"))
    fail("pending-hides-measurement", "pending-hides-measurement");
  const latest = prior.at(-1) ?? null;
  if ((latest ? latest.recordHash : null) !== body.supersedes)
    fail("missing-supersedes", "missing-supersedes");
  const expectedAttempt = prior.reduce((max, record) => Math.max(max, record.attempt), 0) + 1;
  if (body.attempt !== expectedAttempt) fail("attempt-conflict", "attempt-conflict");
  if (body.supersedes !== null) digest(body.supersedes);
  if (input.status === "pending" || input.status === "rejected") {
    if (!PENDING_REASONS.includes(input.pendingReason)) fail("invalid-reason", "invalid-reason");
    body.pendingReason = input.pendingReason;
    body.gateCodes = storedGateCodes(input.gateCodes, false);
  } else if (input.status === "refused") {
    if (input.pendingReason !== null) fail("invalid-reason", "invalid-reason");
    body.gateCodes = storedGateCodes(input.gateCodes, true);
  } else if (input.status === "waived") {
    if (input.pendingReason !== null) fail("invalid-reason", "invalid-reason");
    body.waiver = parseEvidenceWaiver(input.waiver?.reason, input.waiver?.actor);
    if (!body.waiver || body.waiver.reason !== input.waiver.reason)
      fail("invalid-waiver", "invalid-waiver");
    body.artifactDigests = storedArtifacts(input.artifactDigests, scoreboard.RELEASE_TARGETS);
    if (!body.artifactDigests.length) fail("artifact-digest-mismatch", "artifact-digest-mismatch");
  } else {
    const envelope = input.envelope?.report
      ? scoreboard.parsePerformanceEvidenceEnvelope(input.envelope)
      : scoreboard.createPerformanceEvidenceEnvelope(input.envelope);
    if (envelope.report.build.commit !== input.commit) fail("commit-mismatch", "commit-mismatch");
    const bytes = Buffer.from(scoreboard.canonicalSerialize(envelope));
    body.objectDigest = await putObject(input.root, bytes);
    body.reportDigest = envelope.sha256;
    const measuredMetrics = envelope.report.metrics.filter(
      (metric) => metric.coverage.expected > 0,
    );
    body.observedSamples = measuredMetrics.length
      ? Math.min(...measuredMetrics.map((metric) => metric.observations.length))
      : null;
    const stored = storedArtifacts(input.artifactDigests, scoreboard.RELEASE_TARGETS);
    const buildArtifacts = envelope.report.artifacts.filter(
      (artifact) => artifact.kind === "build",
    );
    if (input.tier === "release" && input.role === "candidate") {
      if (!installersMatchBuildArtifacts(stored, buildArtifacts))
        fail("artifact-digest-mismatch", "artifact-digest-mismatch");
    } else if (
      stored.some(
        (artifact) =>
          !buildArtifacts.some(
            (build) => build.sha256 === artifact.sha256 && build.bytes === artifact.bytes,
          ),
      )
    )
      fail("artifact-digest-mismatch", "artifact-digest-mismatch");
    body.artifactDigests = stored;
    if (input.verdictDigest !== undefined && input.verdictDigest !== null) {
      digest(input.verdictDigest);
      body.verdictDigest = input.verdictDigest;
    }
  }
  assertPublicValue(body);
  return { ...body, recordHash: hashRecord(body, scoreboard.contentDigest) };
}

/** Appends in one write, or replaces the whole chain through a renamed temporary file. */
async function writeLines(root, records, { replace = false } = {}) {
  if (!records.length && !replace) return;
  const { canonicalSerialize } = await loadScoreboard();
  const text = records.map((record) => `${canonicalSerialize(record)}\n`).join("");
  const file = recordsPath(root);
  const target = replace ? `${file}.next` : file;
  const handle = await open(target, replace ? "w" : "a");
  try {
    await handle.write(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (replace) await rename(target, file);
}

/** Validates each input against the chain and the inputs before it. A new genesis names its origin. */
async function normalizeRecords(root, inputs, existing) {
  const origin = existing.length ? null : await chainOrigin(root);
  const records = [...existing];
  for (const input of inputs)
    records.push(await normalizeRecord({ chainOrigin: origin, ...input, root }, records));
  return records.slice(existing.length);
}

/** One read of the chain and one write, under one lock. `build` sees the chain it extends. */
export async function appendIndexRecords(root, build, options = {}) {
  return withIndexLock(
    root,
    async () => {
      const existing = await readIndexUnlocked(root);
      const appended = await normalizeRecords(root, await build(existing), existing);
      await writeLines(root, appended);
      return { existing, appended };
    },
    options,
  );
}

const CHAIN_ORIGIN_FILE = ".chain-origin";
const defaultWarn = (message) =>
  process.stdout.write(`::warning title=Scoreboard index::${message}\n`);

/** Starts a fresh chain in `root` naming why the prior chain was not restored. */
async function startNewChain(root, origin) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, CHAIN_ORIGIN_FILE), `${origin}\n`, { flag: "wx" });
  return origin;
}

/**
 * A restored chain that fails verification never blocks a later run: it starts a fresh chain
 * instead of rethrowing, named `schema-upgrade` for a schema-version mismatch (expected after a
 * bump; the versioned artifact name means this should be rare) and `restore-failed` for any other
 * verification failure (a corrupted or tampered upload). `warn` names the failure code, the
 * artifact, and (when known) the run that uploaded it, so a maintainer can find and delete the
 * unreadable upload.
 */
export async function restoreIndex(source, root, missingReason, options = {}) {
  const warn = options.warn ?? defaultWarn;
  const artifact = options.artifact ?? "the restored index";
  const runId = Number.isSafeInteger(options.runId) ? options.runId : null;
  const foundChain = missingReason == null || missingReason === "";
  if (await exists(recordsPath(source))) {
    try {
      await readIndex(source);
    } catch (error) {
      if (!(error instanceof ScoreboardIndexError)) throw error;
      const origin =
        error.code === "unsupported-index-schema" ? "schema-upgrade" : "restore-failed";
      const runLabel = runId !== null ? ` from run ${runId}` : "";
      warn(
        `${artifact}${runLabel} failed verification (${error.code}) and was not restored; ` +
          `starting a new chain instead. Delete that artifact once its replacement has uploaded.`,
      );
      return startNewChain(root, origin);
    }
    if (await exists(root)) {
      const entries = await readdir(root);
      if (entries.length) fail("restore-target-not-empty", "restore-target-not-empty");
    }
    await cp(source, root, { recursive: true, errorOnExist: true, force: false });
    return "restored";
  }
  if (foundChain) fail("missing-restored-chain", "A live index artifact did not restore.");
  if (!CHAIN_ORIGINS.includes(missingReason)) fail("invalid-chain-origin", "invalid-chain-origin");
  return startNewChain(root, missingReason);
}

async function chainOrigin(root) {
  try {
    const value = (await readFile(path.join(root, CHAIN_ORIGIN_FILE), "utf8")).trim();
    if (!CHAIN_ORIGINS.includes(value)) fail("invalid-chain-origin", "invalid-chain-origin");
    return value;
  } catch (error) {
    if (error instanceof ScoreboardIndexError) throw error;
    if (error.code !== "ENOENT") throw error;
    return "first-run";
  }
}

function installerRank(name) {
  const extensions = [".dmg", ".exe", ".AppImage", ".deb", ".zip"];
  const index = extensions.findIndex((extension) => name.endsWith(extension));
  return index === -1 ? extensions.length : index;
}

/** The public `{target, name, sha256, bytes}` shape shared by every distributed-digest list. */
function digestProjection(files) {
  return files.map((file) => ({
    target: file.target,
    name: file.name,
    sha256: file.sha256,
    bytes: file.bytes,
  }));
}

function installerDigestKey(item) {
  return `${item.sha256}:${item.bytes}`;
}

/** True when the installer set and the report's build artifacts name exactly the same bytes. */
function installersMatchBuildArtifacts(files, buildArtifacts) {
  const left = files
    .filter((file) => installerRank(file.name) < 5)
    .map(installerDigestKey)
    .sort()
    .join(",");
  const right = buildArtifacts.map(installerDigestKey).sort().join(",");
  return files.length > 0 && left === right;
}

function targetForPath(relative) {
  const parts = relative.split("/");
  if (parts.length === 2 && DIRECTORY_TARGETS[parts[0]]) return DIRECTORY_TARGETS[parts[0]];
  const name = parts.at(-1) ?? "";
  if (name.includes("-mac-arm64.")) return "desktop-darwin-arm64";
  if (name.includes("-mac-x64.")) return "desktop-darwin-x64";
  if (name.includes("-linux-arm64.")) return "desktop-linux-arm64";
  if (name.includes("-linux-x64.")) return "desktop-linux-x64";
  if (name.includes("-win-x64.")) return "desktop-win32-x64";
  return null;
}

async function hashReleaseTree(root) {
  if (!(await exists(root))) return [];
  const { inventoryArtifact } = await loadScoreboard();
  const inventory = await inventoryArtifact(root);
  const files = [];
  for (const entry of inventory.entries) {
    if (entry.kind !== "file") fail("unmapped-artifact", "unmapped-artifact");
    assertPublicValue(entry.path);
    if (entry.path.includes("..") || path.isAbsolute(entry.path))
      fail("unmapped-artifact", "unmapped-artifact");
    const parts = entry.path.split("/");
    if (parts.length > 2) fail("unmapped-artifact", "unmapped-artifact");
    const name = parts.at(-1);
    artifactName(name);
    const target = targetForPath(entry.path);
    if (installerRank(name) < 5 && !target) fail("unmapped-artifact", "unmapped-artifact");
    files.push({
      target,
      name,
      relativePath: entry.path,
      sha256: entry.sha256,
      bytes: entry.bytes,
    });
  }
  return files;
}

function primaryInstallers(files) {
  const byTarget = new Map();
  for (const file of files) {
    const current = byTarget.get(file.target) ?? [];
    current.push(file);
    byTarget.set(file.target, current);
  }
  const primaries = [];
  for (const [target, group] of byTarget) {
    const installers = group.filter((file) => installerRank(file.name) < 5);
    if (!installers.length) continue;
    installers.sort(
      (left, right) =>
        installerRank(left.name) - installerRank(right.name) || left.name.localeCompare(right.name),
    );
    primaries.push({ target, ...installers[0] });
  }
  return primaries;
}

const ENERGY_PLAN_KEYS = [
  "artifactHash",
  "environmentHash",
  "workloadHash",
  "platform",
  "hardwareClass",
  "conditionsHash",
  "durationMs",
];

function energyEntryLabel(entry, index) {
  const target = typeof entry?.target === "string" ? entry.target : "";
  if (
    /^desktop-[a-z0-9-]+$/.test(target) &&
    !PRIVATE_MARKERS.some((marker) => target.includes(marker))
  )
    return `${index}:${target}`;
  return `entry-${index}`;
}

function judgeEnergyEntry(entry, index, scoreboard) {
  const label = energyEntryLabel(entry, index);
  try {
    exactKeys(entry, ["target", "plan", "capture", "idle"], "invalid-energy-entry");
    assertPublicValue(entry);
    exactKeys(entry.plan, ENERGY_PLAN_KEYS, "invalid-energy-entry");
    const result = scoreboard.ingestPhysicalEnergy(entry.capture, entry.plan, entry.idle);
    return { label, invalid: false, result };
  } catch {
    return { label, invalid: true, result: null };
  }
}

async function validatedEnergy(file, installers) {
  if (!(await exists(file))) return { observed: new Set(), rejections: [] };
  const scoreboard = await loadScoreboard();
  let entries;
  try {
    entries = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { observed: new Set(), rejections: ["energy.json"] };
  }
  if (!Array.isArray(entries)) return { observed: new Set(), rejections: ["energy.json"] };
  const accepted = new Map();
  for (const installer of installers) {
    const values = accepted.get(installer.target) ?? new Set();
    // The inventory entry digest is the published file's bytes. The envelope digest is not accepted.
    values.add(installer.sha256);
    accepted.set(installer.target, values);
  }
  const observed = new Set();
  const rejections = [];
  const workloadHash = (target) =>
    scoreboard.contentDigest({
      suiteVersion: scoreboard.SCOREBOARD_MANIFEST.suiteVersion,
      releaseSamplePlan: {
        replayPairs: scoreboard.SCOREBOARD_MANIFEST.samplePlan.releaseReplayPairs,
        startupObservationsPerStratum:
          scoreboard.SCOREBOARD_MANIFEST.samplePlan.releaseStartupObservationsPerStratum,
        startupStrata: scoreboard.STARTUP_STRATA,
      },
      target,
    });
  for (const [index, entry] of entries.entries()) {
    const judged = judgeEnergyEntry(entry, index, scoreboard);
    if (judged.invalid) {
      rejections.push(judged.label);
      continue;
    }
    const platform = TARGET_PLATFORM[entry.target];
    const acceptedHashes = accepted.get(entry.target);
    if (!acceptedHashes || !platform || observed.has(entry.target)) continue;
    if (
      !acceptedHashes.has(entry.plan.artifactHash) ||
      entry.plan.platform !== platform ||
      entry.plan.workloadHash !== workloadHash(entry.target) ||
      entry.plan.durationMs < scoreboard.SCOREBOARD_MANIFEST.samplePlan.releaseReplayPairs * 1000
    )
      continue;
    if (judged.result.scope === "cpu-package" || judged.result.systemEnergy?.missingReason)
      continue;
    observed.add(entry.target);
  }
  return { observed, rejections };
}

function exactMetricValue(report, metricId) {
  const values =
    report?.metrics
      ?.find((metric) => metric.id === metricId)
      ?.observations.map((observation) => observation.value)
      .filter((value) => value !== null) ?? [];
  if (!values.length || !values.every((value) => value === values[0])) return null;
  return { samples: values.length, value: values[0] };
}

function rowFromComparison(comparison, evidence) {
  const estimate = comparison.estimate;
  const exact = estimate
    ? null
    : exactMetricValue(evidence?.candidate?.report, comparison.metricId);
  const baselineEvidence =
    comparison.baseline === "fixed-release"
      ? evidence?.fixedRelease
      : evidence?.[comparison.baseline];
  const baseline = estimate
    ? null
    : exactMetricValue(baselineEvidence?.report, comparison.metricId);
  return {
    metricId: comparison.metricId,
    baseline: comparison.baseline,
    outcome: comparison.outcome,
    statistic: comparison.statistic,
    samples: estimate?.samplePairs ?? exact?.samples ?? null,
    estimate: estimate?.after.value ?? exact?.value ?? null,
    interval: estimate
      ? { lower: estimate.after.interval.lower, upper: estimate.after.interval.upper }
      : exact
        ? { lower: exact.value, upper: exact.value }
        : null,
    delta: estimate?.degradation.value ?? (exact && baseline ? exact.value - baseline.value : null),
    verdict: comparison.verdict,
  };
}

function metricSummary(report, prefix) {
  const metrics = report.metrics.filter(
    (metric) => metric.id.startsWith(prefix) && metric.coverage.expected > 0,
  );
  if (!metrics.length) return "unknown";
  return metrics
    .map((metric) => `${metric.id} observed ${metric.observations.length}`)
    .sort()
    .join("; ");
}

function safetySummary(report, effectMetricIds) {
  const safety = report.metrics.filter((metric) => effectMetricIds.includes(metric.id));
  const measured = safety.filter((metric) =>
    metric.observations.some((item) => item.value !== null),
  );
  if (!measured.length) return "unknown";
  const failed = measured.filter((metric) => metric.observations.some((item) => item.value > 0));
  const zeroes = measured
    .filter((metric) => metric.observations.every((item) => item.value === 0))
    .map((metric) => metric.id);
  const parts = [];
  if (zeroes.length) parts.push(`measured zero for ${zeroes.sort().join(", ")}`);
  if (failed.length)
    parts.push(
      `failed ${failed
        .map((metric) => metric.id)
        .sort()
        .join(", ")}`,
    );
  const unknown = safety.length - measured.length;
  if (unknown) parts.push(`${unknown} safety metrics unknown`);
  return parts.join("; ") || "unknown";
}

function taskSummary(report) {
  const trials = report.tasks.flatMap((task) => task.trials);
  if (!trials.length) return "unknown";
  const passed = trials.filter((trial) => trial.passed).length;
  const critical = trials.filter((trial) => trial.criticalPassed).length;
  return `${passed}/${trials.length} trials passed; ${critical}/${trials.length} critical checks passed`;
}

function recoverySummary(report) {
  const complete = report.crashes.filter((crash) => crash.status === "complete");
  if (!complete.length) return "unknown";
  const recoveryWords = {
    "automatic-recovery": "recovered by automatic recovery",
    "safe-retry": "retried safely",
    "explicit-uncertainty": "left uncertain",
  };
  return complete
    .map((crash) => {
      const recovery = recoveryWords[crash.recovery] ?? "recovery unknown";
      const safety = crash.safetyPassed === true ? "safety passed" : "safety failed";
      const task = crash.taskCompleted === true ? "task completed" : "task not completed";
      return `${crash.id} ${recovery}, ${safety}, ${task}`;
    })
    .join("; ");
}

function startupSampleCounts(report, strata) {
  const metrics = report.metrics.filter((metric) => metric.id.startsWith("m09."));
  return Object.fromEntries(
    strata.map((stratum) => {
      const counts = metrics.map(
        (metric) =>
          new Set(
            metric.observations
              .filter(
                (observation) =>
                  observation.value !== null &&
                  observation.missingReason === null &&
                  observation.pairId.startsWith(`${stratum}-`),
              )
              .map((observation) => observation.pairId),
          ).size,
      );
      return [stratum, counts.length ? Math.min(...counts) : 0];
    }),
  );
}

function sameCandidateBuild(report, primary) {
  const left = report?.build;
  const right = primary?.build;
  return (
    !!left &&
    !!right &&
    left.commit === right.commit &&
    left.parentCommit === right.parentCommit &&
    left.fixedReleaseCommit === right.fixedReleaseCommit &&
    left.artifactHash === right.artifactHash
  );
}

function guardrailRequirement(id, selection) {
  if (GUARDRAIL_REPORTS[id]) return GUARDRAIL_REPORTS[id];
  if (selection.crashBoundaryIds?.length) return { tier: "T1", label: "T1 durable crash report" };
  return null;
}

/** The pinned effect-safety counts, judged in full on every T1 report. */
function effectSafetyMetricIds(releasePolicy) {
  const guardrails = (releasePolicy?.policy?.guardrails ?? []).filter(
    (guardrail) => guardrail.id === "effect-safety",
  );
  if (!guardrails.length) return undefined;
  return [...new Set(guardrails.flatMap((guardrail) => guardrail.metricIds ?? []))];
}

function candidateEvidenceSet(primary, extras) {
  if (!primary?.report) return [];
  const reports = [primary];
  for (const extra of extras ?? []) {
    if (extra?.report && sameCandidateBuild(extra.report, primary.report)) reports.push(extra);
  }
  return reports;
}

const LIVE_ONLY_METRIC_IDS = new Set(["m05.cache-token-hit", "m05.cache-request-hit"]);

function selectionForTier(selection, tier) {
  if (tier === "T3") return selection;
  return {
    ...selection,
    metricIds: selection.metricIds.filter((id) => !LIVE_ONLY_METRIC_IDS.has(id)),
  };
}

/** T2 comparison drops crash boundaries and metrics with no reviewed declaration. */
function deriveT2Policy(scoreboard, policy, releasePolicy) {
  const t2Ids = [];
  for (const guardrail of releasePolicy.policy.guardrails) {
    if (GUARDRAIL_REPORTS[guardrail.id]?.tier !== "T2") continue;
    for (const id of guardrail.metricIds) if (!t2Ids.includes(id)) t2Ids.push(id);
  }
  const declared = [];
  const undeclaredIds = [];
  for (const id of t2Ids) {
    if (!policy.required.metricIds.includes(id)) continue;
    const definition = scoreboard.METRIC_DEFINITIONS.find((item) => item.id === id);
    if (!definition) continue;
    if (scoreboard.metricBudget(definition, policy).kind === "undeclared") undeclaredIds.push(id);
    else declared.push(id);
  }
  const proposed = scoreboard.createBudgetPolicy(
    {
      metricIds: declared,
      taskIds: [],
      experimentIds: [],
      crashBoundaryIds: [],
      usage: false,
    },
    {
      mode: policy.mode,
      environmentHash: policy.environmentHash,
      scenario: policy.scenario,
      seed: policy.analysis.seed,
      resamples: policy.analysis.resamples,
      nominalQueue: policy.declarations?.nominalQueue,
      retainedSessionGrowthBytes: policy.declarations?.retainedSessionGrowthBytes,
      toolTerminationDeadlineMs: policy.declarations?.toolTerminationDeadlineMs,
    },
  );
  if (!policy.calibration) return { policy: proposed, metricIds: declared, undeclaredIds };
  return {
    policy: scoreboard.freezeBudgetPolicy(
      proposed,
      policy.calibration.reports,
      policy.calibration.frozenAt,
    ),
    metricIds: declared,
    undeclaredIds,
  };
}

const SUMMARY_FROM_GUARDRAIL = {
  taskSummary: "deterministic-tasks",
  safetySummary: "effect-safety",
  recoverySummary: "recovery",
  tokensSummary: "prompt-tokens",
  cacheSummary: "cache-compaction",
  compactionSummary: "cache-compaction",
  memorySummary: "memory",
  bundleSummary: "bundle",
};

function summariesFor(report, effectMetricIds) {
  return {
    taskSummary: taskSummary(report),
    safetySummary: safetySummary(report, effectMetricIds),
    recoverySummary: recoverySummary(report),
    tokensSummary: report.usage.length ? `${report.usage.length} requests` : "unknown",
    cacheSummary: metricSummary(report, "m05."),
    compactionSummary: metricSummary(report, "m06."),
    memorySummary: metricSummary(report, "m10."),
    bundleSummary: metricSummary(report, "m11."),
  };
}

function budgetName(scope) {
  const id = String(scope ?? "")
    .split(":")
    .at(-1);
  return BUDGET_NAMES[id] ?? id.split(".").at(-1).replaceAll("-", " ");
}

function undeclaredDetail(scope) {
  return `The ${budgetName(scope)} budget is not declared.`;
}

/** The working path today, until a physical evidence runner exists (see docs/performance.md). */
const NO_EVIDENCE_DETAIL =
  "No measured evidence exists for this release. To publish a preview now, run the release " +
  "workflow by hand with an evidence_waiver reason.";

/** The four reports a release comparison requires, keyed as `evaluatePublicationGate`'s input is. */
const REPORT_NAME_BY_KEY = {
  parent: "parent.json",
  candidate: "candidate.json",
  fixedRelease: "fixed-release.json",
  policy: "policy.json",
};

/** A partial set never suggests the waiver: the waiver only ever helps when nothing was uploaded. */
function partialEvidenceDetail(missingKeys) {
  const names = missingKeys.map((key) => REPORT_NAME_BY_KEY[key]);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `This release run did not upload ${list}. Every report is required before the release gate can judge this run.`;
}

export async function evaluatePublicationGate(input) {
  const scoreboard = await loadScoreboard();
  const reasons = [];
  const unknowns = [];
  const push = (code, scope, detail = code, extra = {}) => {
    let text = typeof detail === "string" ? detail : code;
    if (text.length > 240 || PRIVATE_MARKERS.some((marker) => text.includes(marker))) text = code;
    reasons.push({ code, scope, detail: text, ...extra });
  };
  if (input.unmapped) push("unmapped-artifact", "artifacts");
  for (const name of input.energyRejections ?? [])
    push("invalid-energy-entry", name, `invalid energy entry ${name}`);
  for (const name of input.unjudgedReports ?? [])
    push("unjudged-report", name, `unjudged report ${name}`);
  const releasePolicy = input.releasePolicy ?? null;
  if (!releasePolicy) push("release-policy-unpinned", "release-policy");
  let verdict = null;
  let candidateReport = null;
  let tiered = false;
  let tierMetricIds = null;
  const undeclaredIds = [];
  const missingReports = Object.keys(REPORT_NAME_BY_KEY).filter((key) => !input[key]);
  if (missingReports.length > 0) {
    push(
      "reports-missing",
      "reports",
      missingReports.length === Object.keys(REPORT_NAME_BY_KEY).length
        ? NO_EVIDENCE_DETAIL
        : partialEvidenceDetail(missingReports),
    );
  } else {
    if (
      releasePolicy &&
      !suppliedPolicyMatches(releasePolicy.policy, input.policy, scoreboard.canonicalSerialize)
    )
      push("release-policy-mismatch", "release-policy");
    const crashesRequired = (input.policy.policy?.required?.crashBoundaryIds?.length ?? 0) > 0;
    const compareTiers =
      input.candidate.report?.scenario?.tier === "T2" && crashesRequired && releasePolicy;
    if (compareTiers) {
      try {
        const derived = deriveT2Policy(scoreboard, input.policy.policy, releasePolicy);
        tiered = true;
        tierMetricIds = derived.metricIds;
        undeclaredIds.push(...derived.undeclaredIds);
        verdict = scoreboard.comparePerformanceEvidence({
          policy: derived.policy,
          parent: input.parent,
          candidate: input.candidate,
          fixedRelease: input.fixedRelease,
        });
      } catch (error) {
        push("invalid-policy", "policy", error instanceof Error ? error.message : "invalid-policy");
      }
    } else
      verdict = scoreboard.comparePerformanceEvidence({
        policy: input.policy,
        parent: input.parent,
        candidate: input.candidate,
        fixedRelease: input.fixedRelease,
      });
    // An undeclared budget blocks the run unless the comparison is tiered by report: tiered
    // scoring already excludes it from the blockers below, so it is only ever advisory there.
    for (const reason of verdict?.reasons ?? [])
      push(
        reason.code,
        reason.scope,
        reason.code === "undeclared-budget" ? undeclaredDetail(reason.scope) : reason.detail,
        reason.code === "undeclared-budget" ? { blocks: !tiered } : {},
      );
    candidateReport = verdict?.evidence?.candidate.report ?? null;
    if (tiered)
      for (const id of undeclaredIds)
        push("undeclared-budget", `candidate:${id}`, undeclaredDetail(id), { blocks: false });
  }
  const candidateSet = candidateEvidenceSet(input.candidateEvidence, input.candidateReports);
  const satisfiedBy = new Map();
  const compared = new Set((verdict?.comparisons ?? []).map((item) => item.metricId));
  const effectMetricIds = effectSafetyMetricIds(releasePolicy);
  // The summary names the counts the judge checks: the pinned list, else the judge's own default.
  const summaryEffectIds = effectMetricIds ?? scoreboard.SAFETY_METRICS;
  if (candidateSet.length && releasePolicy)
    for (const { id, ...selection } of releasePolicy.policy.guardrails) {
      const requirement = guardrailRequirement(id, selection);
      const pool = requirement
        ? candidateSet.filter((item) => item.report.scenario?.tier === requirement.tier)
        : candidateSet;
      if (requirement && !pool.length) {
        const reportName = requirement.tier === "T1" ? "candidate-crash.json" : "candidate.json";
        push("mandatory-evidence-unknown", id, `missing ${requirement.label}: ${reportName}`);
        continue;
      }
      if (requirement?.tier === "T1") {
        // Each T1 report gets the comparison's whole report verdict; any refusal stands.
        const required = selectionForTier(selection, "T1");
        const rules = scoreboard.reportRules(required, effectMetricIds);
        const unjudged = rules.filter((item) => !item.rule).map((item) => item.id);
        if (unjudged.length) {
          push("mandatory-evidence-unknown", id, `no judge rule for ${unjudged.join(", ")}`);
          continue;
        }
        for (const item of rules)
          if (item.rule === "baseline-budget" && !compared.has(item.id))
            unknowns.push(`${item.id} budget: not-compared`);
        let refused = false;
        let detail;
        for (const item of pool) {
          const failures = scoreboard.judgeReport(item.report, required, { effectMetricIds });
          for (const failure of failures) {
            if (failure.code === "incomplete-evidence") detail = failure.detail;
            else {
              refused = true;
              push(failure.code, failure.scope, failure.detail);
            }
          }
          if (!failures.length && !satisfiedBy.has(id)) satisfiedBy.set(id, item);
        }
        if (refused) satisfiedBy.delete(id);
        else if (!satisfiedBy.has(id)) push("mandatory-evidence-unknown", id, detail);
        continue;
      }
      let satisfied = false;
      let detail;
      for (const item of pool) {
        try {
          scoreboard.assertRequiredEvidence(
            item.report,
            selectionForTier(selection, item.report.scenario?.tier),
          );
          satisfied = true;
          satisfiedBy.set(id, item);
          break;
        } catch (error) {
          detail = error instanceof Error ? error.message : undefined;
        }
      }
      if (!satisfied) push("mandatory-evidence-unknown", id, detail);
    }
  const files = input.files ?? [];
  assertPublicValue(digestProjection(files));
  const primaries = primaryInstallers(files);
  let coverage = [];
  try {
    coverage = scoreboard.packagedCoverage(
      primaries.map((file) => ({
        target: file.target,
        artifactHash: file.sha256,
        physicalEnergy: input.energyTargets?.has(file.target) ?? false,
      })),
    );
  } catch {
    push("missing-platform", "coverage");
  }
  // Without any report at all there is nothing to judge platform coverage or energy against;
  // `reports-missing` already says so, and piling on those codes would be noise.
  if (input.candidate) {
    for (const target of REQUIRED_RELEASE_TARGETS) {
      const cell = coverage.find((item) => item.target === target);
      if (cell?.packaged !== "observed") push("missing-platform", target);
      if (cell?.energy !== "observed") push("missing-energy", target);
    }
    for (const cell of coverage) {
      if (REQUIRED_RELEASE_TARGETS.includes(cell.target)) continue;
      if (cell.packaged !== "observed") unknowns.push(`${cell.target} packaged: not-measured`);
      if (cell.energy !== "observed") unknowns.push(`${cell.target} energy: not-measured`);
    }
  }
  let observedSamples = null;
  let observedStartupSamples = Object.fromEntries(
    scoreboard.STARTUP_STRATA.map((stratum) => [stratum, 0]),
  );
  if (candidateReport) {
    const candidateSha = /^[a-f0-9]{40}$/.test(input.candidateSha ?? "")
      ? input.candidateSha
      : null;
    const baseSha = /^[a-f0-9]{40}$/.test(input.baseSha ?? "") ? input.baseSha : null;
    const fixedSha = /^[a-f0-9]{40}$/.test(input.fixedReleaseSha ?? "")
      ? input.fixedReleaseSha
      : null;
    if (!fixedSha) push("missing-fixed-release", "fixed-release");
    if (
      !candidateSha ||
      !baseSha ||
      candidateReport.build.commit !== candidateSha ||
      candidateReport.build.parentCommit !== baseSha ||
      (fixedSha && candidateReport.build.fixedReleaseCommit !== fixedSha)
    )
      push("release-commit-mismatch", "reports");
    if (candidateReport.scenario.tier === "T0") push("tier-not-releasable", "scenario");
    const floor = tiered
      ? scoreboard.SCOREBOARD_MANIFEST.samplePlan.releaseStartupObservationsPerStratum
      : scoreboard.SCOREBOARD_MANIFEST.samplePlan.releaseReplayPairs;
    const requiredIds = tiered
      ? tierMetricIds
      : Array.isArray(input.policy?.policy?.required?.metricIds)
        ? input.policy.policy.required.metricIds
        : [];
    const counts = requiredIds.map(
      (id) => candidateReport.metrics.find((metric) => metric.id === id)?.observations.length ?? 0,
    );
    observedSamples = counts.length ? Math.min(...counts) : 0;
    if (candidateReport.scenario.tier !== "T0" && (!requiredIds.length || observedSamples < floor))
      push(
        "insufficient-samples",
        "sample-plan",
        `observed ${observedSamples}; release plan ${floor}`,
      );
    const startupReports = [
      verdict?.evidence?.parent?.report,
      verdict?.evidence?.candidate?.report,
      verdict?.evidence?.fixedRelease?.report,
    ].filter(Boolean);
    const startupCounts = startupReports.map((report) =>
      startupSampleCounts(report, scoreboard.STARTUP_STRATA),
    );
    observedStartupSamples = Object.fromEntries(
      scoreboard.STARTUP_STRATA.map((stratum) => [
        stratum,
        startupCounts.length
          ? Math.min(...startupCounts.map((countsByStratum) => countsByStratum[stratum]))
          : 0,
      ]),
    );
    const startupFloor =
      scoreboard.SCOREBOARD_MANIFEST.samplePlan.releaseStartupObservationsPerStratum;
    for (const [stratum, count] of Object.entries(observedStartupSamples)) {
      if (count < startupFloor)
        push(
          "insufficient-startup-samples",
          stratum,
          `observed ${count}; release plan ${startupFloor}`,
        );
    }
    const buildArtifacts = candidateReport.artifacts.filter(
      (artifact) => artifact.kind === "build",
    );
    if (!installersMatchBuildArtifacts(files, buildArtifacts))
      push("artifact-digest-mismatch", "artifacts");
  }
  if (input.candidate && input.attachedEvidenceValid !== true)
    push("artifact-digest-mismatch", "scoreboard-candidate.json");
  for (const item of candidateSet) {
    const name = `scoreboard-${item.source}`;
    const published = files.find((file) => file.name === name);
    if (!published || published.sha256 !== item.sha256 || published.bytes !== item.bytes)
      push("artifact-digest-mismatch", name);
  }
  const unique = [];
  for (const reason of reasons) {
    if (!unique.some((item) => item.code === reason.code && item.scope === reason.scope))
      unique.push(reason);
  }
  const blockers = unique.filter((reason) => !(tiered && reason.code === "undeclared-budget"));
  const releaseEligible = tiered
    ? verdict?.releaseEligible === true && blockers.length === 0
    : verdict?.releaseEligible === true;
  const allowPublication = tiered ? releaseEligible : releaseEligible && unique.length === 0;
  const exitCode = allowPublication
    ? 0
    : unique.some((reason) => FAILURE_EXIT_CODES.has(reason.code)) || verdict?.exitCode === 1
      ? 1
      : 2;
  const plan = await samplePlanFor("release");
  const rows = (verdict?.comparisons ?? [])
    .map((comparison) => rowFromComparison(comparison, verdict?.evidence))
    .sort((left, right) =>
      `${left.metricId}:${left.baseline}:${left.outcome}:${left.statistic}`.localeCompare(
        `${right.metricId}:${right.baseline}:${right.outcome}:${right.statistic}`,
      ),
    );
  const fallback = candidateReport ? summariesFor(candidateReport, summaryEffectIds) : null;
  const summaries = {};
  const summarySources = {};
  for (const [key, guardrailId] of Object.entries(SUMMARY_FROM_GUARDRAIL)) {
    const match = satisfiedBy.get(guardrailId);
    const rendered = match ? summariesFor(match.report, summaryEffectIds) : fallback;
    summaries[key] = rendered ? rendered[key] : "unknown";
    // The attached release asset, not the name in the reports artifact.
    summarySources[key] = match ? `scoreboard-${match.source}` : null;
  }
  for (const summary of Object.values(summaries))
    if (summary === "unknown" || summary.includes("unknown")) unknowns.push(summary);
  const requiredEnergy = REQUIRED_RELEASE_TARGETS.filter(
    (target) => coverage.find((cell) => cell.target === target)?.energy === "observed",
  );
  const gate = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    path: "measured",
    allowPublication,
    exitCode,
    reasons: unique,
    unknowns: [...new Set(unknowns)],
    humanAcceptance: "separate",
    releasePolicySha256: releasePolicy?.sha256 ?? null,
    suiteVersion: scoreboard.SCOREBOARD_MANIFEST.suiteVersion,
    suiteHash: scoreboard.suiteHash,
    environment: input.environment,
    samplePlan: plan.label,
    declaredSamples: plan.declaredSamples,
    observedSamples,
    observedStartupSamples,
    calibration: verdict?.calibration ?? "missing",
    policyHash: verdict?.policyHash ?? null,
    verdictStatus: verdict?.status ?? "missing",
    rows,
    ...summaries,
    summarySources,
    energySummary:
      requiredEnergy.length === REQUIRED_RELEASE_TARGETS.length
        ? `observed on ${requiredEnergy.join(", ")}`
        : "unknown",
    attachedEvidenceSha256: input.attachedEvidenceDigest ?? null,
    canonicalEnvelopeSha256: input.candidate
      ? sha256(Buffer.from(scoreboard.canonicalSerialize(input.candidate)))
      : null,
    distributedDigests: digestProjection(files),
    coverage,
    releaseEligible,
  };
  if (gate.energySummary === "unknown")
    gate.unknowns = [...new Set([...gate.unknowns, "energy: unknown"])];
  assertPublicValue(gate);
  return gate;
}

function cell(value) {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length) return value;
  return "unknown";
}

function undeclaredPublicationLines(gate) {
  const names = [
    ...new Set(
      (Array.isArray(gate.reasons) ? gate.reasons : [])
        .filter((reason) => reason?.code === "undeclared-budget")
        .map((reason) =>
          String(reason.scope ?? "")
            .split(":")
            .at(-1),
        )
        .filter((id) => /^[a-z][a-z0-9.-]*$/.test(id))
        .map(budgetName),
    ),
  ].sort();
  if (!names.length) return [];
  const one = names.length === 1;
  const count = ["One", "Two", "Three"][names.length - 1] ?? String(names.length);
  return [
    "",
    one
      ? `One release budget is not declared yet, so it was not checked: ${names[0]}. It must be declared before a release can be measured against it.`
      : `${count} release budgets are not declared yet, so they were not checked: ${names.join(", ")}. They must be declared before a release can be measured against them.`,
  ];
}

export function renderScoreboardNotes(gate) {
  if (gate?.path === "waiver") {
    exactKeys(
      gate,
      [
        "schemaVersion",
        "path",
        "allowPublication",
        "exitCode",
        "reasons",
        "waiver",
        "distributedDigests",
      ],
      "invalid-gate",
    );
    const passed = gate.allowPublication === true && !gate.reasons.length;
    if (passed) exactKeys(gate.waiver, ["reason"], "invalid-gate");
    const reason = passed ? parseWaiverReason(gate.waiver.reason) : null;
    if (reason === null || reason !== gate.waiver.reason)
      fail("notes-require-validated-gate", "Release notes require a publication gate that passed.");
    const notes = [
      "## Performance evidence",
      "",
      `This preview was published without measured performance evidence: ${reason}.`,
      "",
    ].join("\n");
    assertPublicValue(notes);
    return notes;
  }
  exactKeys(
    gate,
    [
      "schemaVersion",
      "path",
      "allowPublication",
      "exitCode",
      "reasons",
      "unknowns",
      "humanAcceptance",
      "releasePolicySha256",
      "suiteVersion",
      "suiteHash",
      "environment",
      "samplePlan",
      "declaredSamples",
      "observedSamples",
      "observedStartupSamples",
      "calibration",
      "policyHash",
      "verdictStatus",
      "rows",
      "taskSummary",
      "safetySummary",
      "recoverySummary",
      "tokensSummary",
      "cacheSummary",
      "compactionSummary",
      "memorySummary",
      "bundleSummary",
      "summarySources",
      "energySummary",
      "attachedEvidenceSha256",
      "canonicalEnvelopeSha256",
      "distributedDigests",
      "coverage",
      "releaseEligible",
    ],
    "invalid-gate",
  );
  if (
    gate.path !== "measured" ||
    gate.allowPublication !== true ||
    gate.humanAcceptance !== "separate" ||
    gate.releaseEligible !== true
  )
    fail(
      "notes-require-validated-gate",
      "Release notes require a publication gate that passed and still separates human acceptance.",
    );
  const lines = [
    "## Measured evidence",
    "",
    `The scoreboard suite is ${gate.suiteVersion}.`,
    `These measurements were taken in the ${gate.environment} environment.`,
    `The ${gate.samplePlan} plan requires ${gate.declaredSamples.pairs} paired observations and ${cell(gate.declaredSamples.startupPerStratum)} startup observations per stratum. Observed samples: ${cell(gate.observedSamples)}.`,
    `Observed startup samples by stratum: ${Object.entries(gate.observedStartupSamples)
      .map(([stratum, count]) => `${stratum} ${count}`)
      .join("; ")}.`,
    `The budget policy is ${gate.calibration}. The measured evidence verdict is ${gate.verdictStatus}.`,
    ...undeclaredPublicationLines(gate),
    "",
    "| Metric | Baseline | Outcome | Statistic | Samples | Estimate | Interval | Delta | Verdict |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  if (!gate.rows.length)
    lines.push(
      "| unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown |",
    );
  for (const row of gate.rows) {
    const interval = row.interval ? `${row.interval.lower}..${row.interval.upper}` : "unknown";
    lines.push(
      `| ${cell(row.metricId)} | ${cell(row.baseline)} | ${cell(row.outcome)} | ${cell(row.statistic)} | ${cell(row.samples)} | ${cell(row.estimate)} | ${interval} | ${cell(row.delta)} | ${cell(row.verdict)} |`,
    );
  }
  exactKeys(gate.summarySources, Object.keys(SUMMARY_FROM_GUARDRAIL), "invalid-gate");
  lines.push("");
  for (const [key, label] of [
    ["taskSummary", "Task success"],
    ["safetySummary", "Critical safety"],
    ["recoverySummary", "Recovery"],
    ["tokensSummary", "Tokens"],
    ["cacheSummary", "Cache"],
    ["compactionSummary", "Compaction"],
    ["memorySummary", "Memory"],
    ["bundleSummary", "Bundles"],
  ]) {
    const source = gate.summarySources[key];
    if (
      source !== null &&
      (typeof source !== "string" || !/^scoreboard-[a-z0-9][a-z0-9.-]*\.json$/.test(source))
    )
      fail("invalid-gate", "invalid-gate");
    lines.push(`${label}: ${gate[key]}.`);
    if (source) lines.push(`Report: ${source}.`);
  }
  lines.push(`Energy: ${gate.energySummary}.`, "", "Unknowns:");
  if (!gate.unknowns.length) lines.push("- none");
  for (const unknown of gate.unknowns) lines.push(`- ${unknown}`);
  lines.push(
    "",
    `The attached evidence file SHA-256 is ${cell(gate.attachedEvidenceSha256)}.`,
    `The canonical evidence envelope SHA-256 is ${cell(gate.canonicalEnvelopeSha256)}.`,
    "",
    "Human acceptance is separate and is not granted by this evidence.",
    "",
  );
  const notes = lines.join("\n");
  assertPublicValue(notes);
  return notes;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The extra candidate reports the gate judges: a public, parseable envelope of the same build as
 * `candidate.json`. Any other `candidate-*.json` is unjudged; the gate refuses it by name and
 * staging publishes nothing, because an unjudged file must never become a release asset.
 */
async function judgeCandidateReports(reportsRoot, primary) {
  let names = [];
  try {
    names = (await readdir(reportsRoot)).filter((name) => /^candidate-.+\.json$/.test(name)).sort();
  } catch {
    return { accepted: [], unjudged: [] };
  }
  const scoreboard = await loadScoreboard();
  const accepted = [];
  const unjudged = [];
  for (const [index, name] of names.entries()) {
    try {
      const raw = await readFile(path.join(reportsRoot, name));
      const text = raw.toString("utf8");
      assertPublicValue(text);
      const envelope = scoreboard.parsePerformanceEvidenceEnvelope(JSON.parse(text));
      if (!primary?.report || !sameCandidateBuild(envelope.report, primary.report))
        fail("unjudged-report", "unjudged-report");
      accepted.push({
        source: name,
        sha256: sha256(raw),
        bytes: raw.length,
        report: envelope.report,
      });
    } catch {
      const safe =
        /^candidate-[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/.test(name) && !name.includes("..");
      unjudged.push(safe ? name : `candidate-report-${index}`);
    }
  }
  return { accepted, unjudged };
}

const PUBLICATION_REPORTS = [
  "parent.json",
  "candidate.json",
  "fixed-release.json",
  "policy.json",
  "energy.json",
];

/**
 * Copy exactly the reports the release gate judges into the flat publication directory. An
 * invalid energy entry or an unjudged candidate report stages nothing.
 */
export async function stagePublicationReports(reportsRoot, destination) {
  if (typeof reportsRoot !== "string" || typeof destination !== "string")
    fail("invalid-argument", "invalid-argument");
  await mkdir(destination, { recursive: true });
  const energyFile = path.join(reportsRoot, "energy.json");
  if (await exists(energyFile)) {
    const energy = await validatedEnergy(energyFile, []);
    if (energy.rejections.length) return;
  }
  const extras = await judgeCandidateReports(
    reportsRoot,
    await readJson(path.join(reportsRoot, "candidate.json")),
  );
  if (extras.unjudged.length) return;
  for (const name of [...PUBLICATION_REPORTS, ...extras.accepted.map((item) => item.source)]) {
    const from = path.join(reportsRoot, name);
    if (!(await exists(from))) continue;
    const published = `scoreboard-${name}`;
    artifactName(published);
    await cp(from, path.join(destination, published));
  }
}

function releaseRecordBase(options, suiteVersion, environmentHash) {
  return {
    tier: "release",
    mode: "release",
    suiteVersion,
    environment: options.environment,
    environmentHash,
    indexedAt: options.indexedAt ?? new Date().toISOString(),
    runnerCommit: options.runnerCommit,
    fixedReleaseCommit: options.fixedReleaseSha || null,
  };
}

/** Attempt and supersedes come from the chain the record extends, read under the same lock. */
function nextFor(records, key) {
  const prior = records.filter((record) => sameKey(record, key));
  return {
    prior,
    attempt: nextAttempt(records, key),
    supersedes: prior.at(-1)?.recordHash ?? null,
  };
}

function candidateKey(options, suiteHash) {
  return {
    commit: options.candidateSha,
    suiteHash,
    environment: options.environment,
    role: "candidate",
    tier: "release",
  };
}

async function recordUnpublished(options, gate, common) {
  const scoreboard = await loadScoreboard();
  const gateCodes = classifyGateCodes(gate.reasons.map((reason) => reason.code));
  const refusal = gateCodes.some((code) => REFUSAL_CODES.has(code));
  const metricIds = metricIdsFromReasons(gate.reasons);
  if (options.candidateSha && /^[a-f0-9]{40}$/.test(options.candidateSha)) {
    await appendIndexRecords(options.indexRoot, (records) => {
      const { prior, attempt, supersedes } = nextFor(
        records,
        candidateKey(options, scoreboard.suiteHash),
      );
      return [
        {
          ...common,
          status: refusal
            ? "refused"
            : prior.some((record) => record.status === "measured")
              ? "rejected"
              : "pending",
          commit: options.candidateSha,
          parentCommit: /^[a-f0-9]{40}$/.test(options.baseSha ?? "") ? options.baseSha : null,
          role: "candidate",
          attempt,
          supersedes,
          pendingReason: refusal ? null : pendingReasonFor(gate.reasons),
          gateCodes,
          metricIds,
        },
      ];
    });
  }
  return gate.exitCode;
}

/** A waiver publishes installers only; it never reads, produces or implies measurements. */
async function runWaivedRelease(options, files, unmapped) {
  const scoreboard = await loadScoreboard();
  const reasons = [];
  const push = (code, scope) => reasons.push({ code, scope, detail: code });
  if (unmapped) push("unmapped-artifact", "artifacts");
  if (options.trigger !== "workflow_dispatch") push("waiver-not-permitted", "trigger");
  const waiver = parseEvidenceWaiver(options.waiver, options.actor ?? "");
  if (!waiver) push("invalid-waiver", "waiver");
  // A report the waiver must refuse beside is any entry at all in the reports directory, whatever
  // it is named or how deeply it is nested — no naming check can be blind to it.
  if (
    (await directoryHasEntries(options.reportsRoot)) ||
    files.some((file) => file.name.startsWith("scoreboard-"))
  )
    push("waiver-with-evidence", "reports");
  const primaries = primaryInstallers(files);
  for (const target of REQUIRED_RELEASE_TARGETS)
    if (!primaries.some((file) => file.target === target)) push("missing-platform", target);
  const allowPublication = reasons.length === 0;
  // gate.json is uploaded with the release, so it carries the reason and never the account.
  const gate = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    path: "waiver",
    allowPublication,
    exitCode: allowPublication
      ? 0
      : reasons.some((reason) => FAILURE_EXIT_CODES.has(reason.code))
        ? 1
        : 2,
    reasons,
    waiver: allowPublication ? { reason: waiver.reason } : null,
    distributedDigests: digestProjection(files),
  };
  assertPublicValue(gate);
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${scoreboard.canonicalSerialize(gate)}\n`);
  const common = releaseRecordBase(options, scoreboard.SCOREBOARD_MANIFEST.suiteVersion, null);
  if (!allowPublication) return recordUnpublished(options, gate, common);
  const { existing, appended } = await appendIndexRecords(options.indexRoot, (records) => {
    const { attempt, supersedes } = nextFor(records, candidateKey(options, scoreboard.suiteHash));
    return [
      {
        ...common,
        status: "waived",
        commit: options.candidateSha,
        parentCommit: /^[a-f0-9]{40}$/.test(options.baseSha ?? "") ? options.baseSha : null,
        role: "candidate",
        attempt,
        supersedes,
        pendingReason: null,
        artifactDigests: gate.distributedDigests,
        waiver,
      },
    ];
  });
  // The public waiver record points at its index line; the account stays in that line.
  const waiverRecord = {
    reason: waiver.reason,
    runId: Number.isSafeInteger(options.runId) ? options.runId : null,
    indexLine: existing.length + 1,
    recordHash: appended[0].recordHash,
  };
  assertPublicValue(waiverRecord);
  await writeFile(
    path.join(path.dirname(options.outputPath), "waiver-record.json"),
    `${JSON.stringify(waiverRecord)}\n`,
  );
  return 0;
}

export async function runReleaseGate(options) {
  const scoreboard = await loadScoreboard();
  let files = [];
  let unmapped = false;
  try {
    files = await hashReleaseTree(options.artifactRoot);
  } catch (error) {
    if (!(error instanceof ScoreboardIndexError) || error.code !== "unmapped-artifact") throw error;
    unmapped = true;
  }
  if (typeof options.waiver === "string" && options.waiver !== "")
    return runWaivedRelease(options, files, unmapped);
  const installers = files.filter((file) => installerRank(file.name) < 5);
  let energyTargets = new Set();
  let energyRejections = [];
  const energyFile = path.join(options.reportsRoot, "energy.json");
  if (await exists(energyFile)) {
    const energy = await validatedEnergy(energyFile, installers);
    energyTargets = energy.observed;
    energyRejections = energy.rejections;
  }
  const [parent, candidate, fixedRelease, policy] = await Promise.all(
    REPORT_FILES.map((name) => readJson(path.join(options.reportsRoot, name))),
  );
  const attachedCandidate = files.find((file) => file.name === "scoreboard-candidate.json");
  let attachedEvidenceDigest = null;
  let attachedEvidenceValid = false;
  if (attachedCandidate && candidate) {
    try {
      const bytes = await readFile(path.join(options.artifactRoot, attachedCandidate.relativePath));
      attachedEvidenceDigest = sha256(bytes);
      const parsed = JSON.parse(bytes.toString("utf8"));
      attachedEvidenceValid =
        attachedEvidenceDigest === attachedCandidate.sha256 &&
        scoreboard.canonicalSerialize(parsed) === scoreboard.canonicalSerialize(candidate);
    } catch {
      attachedEvidenceValid = false;
    }
  }
  let candidateEvidence = null;
  if (candidate?.report) {
    const raw = await readFile(path.join(options.reportsRoot, "candidate.json"));
    candidateEvidence = {
      source: "candidate.json",
      sha256: sha256(raw),
      bytes: raw.length,
      report: candidate.report,
    };
  }
  const extras = await judgeCandidateReports(options.reportsRoot, candidate);
  const gate = await evaluatePublicationGate({
    parent,
    candidate,
    candidateEvidence,
    candidateReports: extras.accepted,
    unjudgedReports: extras.unjudged,
    fixedRelease,
    policy,
    files,
    energyTargets,
    energyRejections,
    unmapped,
    attachedEvidenceDigest,
    attachedEvidenceValid,
    candidateSha: options.candidateSha,
    baseSha: options.baseSha,
    fixedReleaseSha: options.fixedReleaseSha || null,
    environment: options.environment,
    releasePolicy: await loadReleasePolicy(
      options.releasePolicyPath ?? RELEASE_POLICY_FILE,
      options.releasePolicySha256 ?? RELEASE_POLICY_SHA256,
    ),
  });
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${scoreboard.canonicalSerialize(gate)}\n`);
  const common = releaseRecordBase(
    options,
    gate.suiteVersion,
    candidate?.report?.environmentHash ?? null,
  );
  if (!gate.allowPublication) return recordUnpublished(options, gate, common);
  const roles = [
    ["candidate", candidate, options.candidateSha, digestProjection(files)],
    ["parent", parent, options.baseSha, []],
    ["fixed-release", fixedRelease, options.fixedReleaseSha, []],
  ];
  await appendIndexRecords(options.indexRoot, (records) =>
    roles.map(([role, envelope, commit, digests]) => {
      const { attempt, supersedes } = nextFor(records, {
        commit,
        suiteHash: gate.suiteHash,
        environment: options.environment,
        role,
        tier: "release",
      });
      return {
        ...common,
        status: "measured",
        role,
        commit,
        parentCommit: envelope.report.build.parentCommit,
        fixedReleaseCommit: envelope.report.build.fixedReleaseCommit,
        attempt,
        supersedes,
        envelope,
        artifactDigests: digests,
        verdictDigest: gate.policyHash,
      };
    }),
  );
  return 0;
}

function firstParentRevList(args) {
  return parseRevListParents(
    execFileSync("git", ["rev-list", "--first-parent", "--parents", ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }),
  );
}

function retentionSince(now = new Date()) {
  return new Date(
    now.getTime() - WORKFLOW_ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000 - 1000,
  ).toISOString();
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
}

function newestCommit(shas) {
  const listed = git(["rev-list", "--max-count=1", ...shas]);
  sha40(listed);
  return listed;
}

/** The commits of `shas` that this clone still has, from one `git cat-file` call. */
function presentCommits(shas) {
  const listed = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    input: shas.map((sha) => `${sha}\n`).join(""),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return listed
    .split("\n")
    .filter((line) => line.endsWith(" commit"))
    .map((line) => line.split(" ")[0]);
}

function parentOf(head) {
  try {
    const parent = git(["rev-parse", `${head}^`]);
    return /^[a-f0-9]{40}$/.test(parent) ? parent : null;
  } catch {
    return null;
  }
}

/** A durable push always records the commit it pushed, even one older than the retention window. */
function ensureHead(commits, head) {
  if (commits.some((item) => item.commit === head)) return commits;
  return [...commits, { commit: head, parentCommit: parentOf(head) }];
}

/**
 * A durable chain resumes after the nearest first-parent ancestor it contains. A chain with no
 * such ancestor walks back to its newest commit, and an empty chain to the 90-day artifact window;
 * both walks stop at that window. A chain whose commits are all gone from the clone was left
 * behind by a history rewrite, so it is reset and enumeration starts as for an empty chain. `now`
 * is the retention window's clock, so it never depends on the wall clock at test or run time.
 */
function enumerateBackfill(records, head, now = new Date()) {
  const indexed = new Set(
    records
      .filter((record) => record.tier === "commit" && record.role === "candidate")
      .map((record) => record.commit),
  );
  const since = `--since=${retentionSince(now)}`;
  if (indexed.size) {
    const history = firstParentRevList([head]);
    const nearest = history.findIndex((item) => indexed.has(item.commit));
    if (nearest >= 0)
      return {
        commits: history.slice(0, nearest).reverse(),
        enumerationStart: null,
        enumerationReason: null,
        rewritten: false,
      };
    const present = presentCommits([...indexed]);
    if (present.length) {
      const enumerationStart = newestCommit(present);
      return {
        commits: ensureHead(
          firstParentRevList(["--reverse", since, `${enumerationStart}..${head}`]),
          head,
        ),
        enumerationStart,
        enumerationReason: "chain-without-ancestor",
        rewritten: false,
      };
    }
  }
  const commits = ensureHead(firstParentRevList(["--reverse", since, head]), head);
  const enumerationStart = commits[0]?.commit ?? null;
  return {
    commits,
    enumerationStart,
    enumerationReason: enumerationStart ? "empty-chain-retention-window" : null,
    rewritten: indexed.size > 0,
  };
}

/** Commits between the merge base and head, or head alone. Never the retention window. */
function boundedCommits(range) {
  if (range.kind === "single") return [{ commit: range.head, parentCommit: parentOf(range.head) }];
  const mergeBase = git(["merge-base", range.base, range.head]);
  sha40(mergeBase);
  return firstParentRevList(["--reverse", `${mergeBase}..${range.head}`]);
}

/**
 * Records every commit of this run as measured or pending with one read of the chain and one
 * write. Only a durable push (`backfill`) walks history; other runs index their own commits.
 * `now` is the retention window's clock: it defaults to the real clock but a caller, including
 * the CLI's `SCOREBOARD_NOW`, can fix it so the window never depends on wall-clock time.
 */
export async function runIndexPush(options) {
  const scoreboard = await loadScoreboard();
  const mode = options.mode ?? "commit";
  const now = options.now ?? new Date();
  let commits = options.commits ?? null;
  if (!commits && options.commitsFile) {
    const parsed = JSON.parse(await readFile(options.commitsFile, "utf8"));
    if (!Array.isArray(parsed)) fail("invalid-commits", "invalid-commits");
    commits = parsed;
  }
  const range = commits ? null : selectCommitRange({ base: options.base, head: options.head });
  const headCommit = options.head || null;
  const warn =
    options.warn ??
    ((message) => process.stdout.write(`::warning title=Scoreboard index::${message}\n`));
  const tier = mode === "release" ? "release" : "commit";
  return withIndexLock(options.root, async () => {
    let existing = await readIndexUnlocked(options.root);
    let enumerationStart = null;
    let enumerationReason = null;
    let reset = false;
    if (!commits) {
      try {
        if (mode === "commit" && options.backfill) {
          const resumed = enumerateBackfill(existing, range.head, now);
          ({ commits, enumerationStart, enumerationReason } = resumed);
          reset = resumed.rewritten;
        } else commits = boundedCommits(range);
      } catch (error) {
        if (error instanceof ScoreboardIndexError) throw error;
        fail("infrastructure-unavailable", "The commit range could not be read.");
      }
    }
    if (reset) {
      warn(
        "The indexed commits are no longer in this repository's history, so the index starts a new chain.",
      );
      existing = [];
      await rm(path.join(options.root, "objects"), { recursive: true, force: true });
    }
    const planned = planEvidenceRecords({
      commits,
      pendingReason: options.pendingReason ?? "schema-3-evidence-not-produced",
      headCommit,
    });
    const indexedAt = options.indexedAt ?? now.toISOString();
    const inputs = planned.map((item) => {
      const { attempt, supersedes } = nextFor(existing, {
        commit: item.commit,
        suiteHash: scoreboard.suiteHash,
        environment: options.environment,
        role: "candidate",
        tier,
      });
      return {
        // No caller supplies an actual measurement for this push, so no prior record here is ever
        // `measured`, and this record is always `pending`.
        status: "pending",
        tier,
        mode,
        commit: item.commit,
        parentCommit: item.parentCommit,
        fixedReleaseCommit: options.fixedReleaseCommit ?? null,
        suiteVersion: options.suiteVersion,
        environment: options.environment,
        environmentHash: null,
        role: "candidate",
        indexedAt,
        runnerCommit: options.runnerCommit,
        attempt,
        supersedes,
        ...(reset ? { chainOrigin: "history-rewritten" } : {}),
        enumerationStart,
        enumerationReason,
        pendingReason: item.pendingReason,
      };
    });
    const appended = await normalizeRecords(options.root, inputs, existing);
    await writeLines(options.root, appended, { replace: reset });
    const audit = auditCommits(
      [...existing, ...appended],
      planned.map((item) => ({ commit: item.commit })),
    );
    return audit.complete ? 0 : 1;
  });
}

export async function publicationFiles(root) {
  const entries = (await readdir(root, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) fail("upload-directory", "Publication uploads must contain files only.");
    artifactName(entry.name);
    const bytes = await readFile(path.join(root, entry.name));
    const target = targetForPath(entry.name);
    if (installerRank(entry.name) < 5 && !target) fail("unmapped-artifact", "unmapped-artifact");
    files.push({
      target,
      name: entry.name,
      sha256: sha256(bytes),
      bytes: bytes.length,
    });
  }
  return files;
}

export async function verifyPublicationBytes(root, gate) {
  const actual = await hashReleaseTree(root);
  const serialize = (files) =>
    files
      .map((file) => `${file.target ?? ""}:${file.name}:${file.sha256}:${file.bytes}`)
      .sort()
      .join("\n");
  if (serialize(actual) !== serialize(gate?.distributedDigests ?? []))
    fail("artifact-digest-mismatch", "Published bytes differ from the validated gate.");
  return actual;
}

export function durableIndexScope({ eventName, ref }) {
  return eventName === "push" && (ref === "refs/heads/dev" || ref === "refs/heads/main");
}

/** `name` undefined lists every artifact of the run, unfiltered. */
async function listRunArtifacts(request, repository, runId, name) {
  const artifacts = [];
  for (let page = 1; artifacts.length < 1000; page += 1) {
    const query = { per_page: 100, page };
    if (name !== undefined) query.name = name;
    const response = await request(`/repos/${repository}/actions/runs/${runId}/artifacts`, query);
    const listed = (Array.isArray(response?.artifacts) ? response.artifacts : []).filter(
      (artifact) => name === undefined || artifact?.name === name,
    );
    artifacts.push(...listed);
    const pageLength = Array.isArray(response?.artifacts) ? response.artifacts.length : 0;
    if (pageLength < 100) break;
  }
  return artifacts;
}

/**
 * A filtered workflow-run search returns at most 1,000 results for actor, branch,
 * check_suite_id, created, event, head_sha, and status:
 * https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow
 * The listing order is not documented. When total_count is above 1,000 or the
 * listing returns 1,000 runs, the created range is halved until each slice lists
 * under that cap. Slices are walked newest first. A chain origin is returned only
 * after every slice down to the window start has been inspected. The first listing
 * starts one day before the window because the created filter is calendar-day
 * granularity.
 */
const WORKFLOW_RUN_SEARCH_CAP = 1000;

/** Search date-time form documented for the workflow-run `created` parameter. */
function createdBound(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

async function listFilteredWorkflowRuns(request, repository, scope, branch, created, pageSize) {
  const runs = [];
  let totalCount = 0;
  for (let page = 1; runs.length < WORKFLOW_RUN_SEARCH_CAP; page += 1) {
    const query = {
      status: scope.status,
      created,
      exclude_pull_requests: "true",
      per_page: pageSize,
      page,
    };
    if (branch !== null) query.branch = branch;
    if (scope.events.length === 1) query.event = scope.events[0];
    const response = await request(
      `/repos/${repository}/actions/workflows/${scope.workflow}/runs`,
      query,
    );
    const reported = Number(response?.total_count);
    if (Number.isFinite(reported)) totalCount = reported;
    const listed = Array.isArray(response?.workflow_runs) ? response.workflow_runs : [];
    runs.push(...listed);
    if (reported > WORKFLOW_RUN_SEARCH_CAP || runs.length >= WORKFLOW_RUN_SEARCH_CAP)
      return { runs, capped: true };
    if (listed.length < pageSize) break;
  }
  return {
    runs,
    capped: totalCount > WORKFLOW_RUN_SEARCH_CAP || runs.length >= WORKFLOW_RUN_SEARCH_CAP,
  };
}

export async function findPriorIndexArtifact({
  scope: scopeName = "commit",
  repository,
  branch = null,
  request,
  now = new Date(),
  hasIndexJob,
  indexJobPredates,
  pageSize = 100,
}) {
  const scope = INDEX_SCOPES[scopeName];
  if (!scope || (scopeName === "commit") !== (typeof branch === "string"))
    fail("invalid-argument", "invalid-argument");
  const windowStart = new Date(
    now.getTime() - WORKFLOW_ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const listedFrom = new Date(windowStart.getTime() - 24 * 60 * 60 * 1000);
  const seen = new Set();

  async function walkSlice(runs) {
    const candidates = (Array.isArray(runs) ? runs : [])
      .filter(
        (run) =>
          scope.events.includes(run?.event) &&
          (branch === null || run.head_branch === branch) &&
          run.head_repository?.full_name === repository &&
          (scope.status !== "success" || run.conclusion === "success") &&
          Number.isSafeInteger(run.id) &&
          !seen.has(run.id) &&
          hasIndexJob(run.head_sha),
      )
      .sort(
        (left, right) =>
          Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id,
      );
    let expired = false;
    let sawRun = false;
    let schemaUpgrade = false;
    for (const run of candidates) {
      seen.add(run.id);
      const createdAt = Date.parse(run.created_at);
      if (!Number.isFinite(createdAt) || createdAt < windowStart.getTime()) break;
      sawRun = true;
      // One unfiltered listing per run covers both the current-schema search and, should that
      // fail for every run in the window, whether any of them uploaded an older schema's name.
      const artifacts = (await listRunArtifacts(request, repository, run.id, undefined)).filter(
        (artifact) => artifact.workflow_run?.id === run.id,
      );
      const current = artifacts.filter((artifact) => artifact.name === scope.artifact);
      if (current.some((artifact) => artifact.expired === false))
        return { live: run.id, expired, sawRun, schemaUpgrade };
      if (current.some((artifact) => artifact.expired === true)) expired = true;
      if (
        !schemaUpgrade &&
        artifacts.some(
          (artifact) => scope.otherSchema.test(artifact.name) && artifact.name !== scope.artifact,
        )
      )
        schemaUpgrade = true;
    }
    return { live: null, expired, sawRun, schemaUpgrade };
  }

  async function inspectRange(start, end, root) {
    const created = root
      ? `>=${start.toISOString().slice(0, 10)}`
      : `${createdBound(start)}..${createdBound(end)}`;
    const listed = await listFilteredWorkflowRuns(
      request,
      repository,
      scope,
      branch,
      created,
      pageSize,
    );
    if (listed.capped && end.getTime() - start.getTime() >= 2) {
      const mid = start.getTime() + Math.floor((end.getTime() - start.getTime()) / 2);
      const newer = await inspectRange(new Date(mid + 1), end, false);
      if (newer.live != null) return newer;
      const older = await inspectRange(start, new Date(mid), false);
      return {
        live: older.live,
        expired: newer.expired || older.expired,
        sawRun: newer.sawRun || older.sawRun,
        schemaUpgrade: newer.schemaUpgrade || older.schemaUpgrade,
      };
    }
    return walkSlice(listed.runs);
  }

  const found = await inspectRange(listedFrom, now, true);
  if (found.live != null) return { runId: found.live, missingReason: null };
  if (found.expired) return { runId: null, missingReason: "expired-after-90-days-inactivity" };
  if (found.sawRun)
    return {
      runId: null,
      missingReason: found.schemaUpgrade ? "schema-upgrade" : "prior-artifact-missing",
    };
  return {
    runId: null,
    missingReason: indexJobPredates(windowStart) ? "expired-after-90-days-inactivity" : "first-run",
  };
}

/** True when this run uploaded scoreboard-reports, including an expired artifact. */
export async function reportsArtifactPresent({
  repository,
  runId,
  request,
  name = "scoreboard-reports",
}) {
  if (!Number.isSafeInteger(runId)) fail("invalid-run", "invalid-run");
  const artifacts = await listRunArtifacts(request, repository, runId, name);
  return artifacts.length > 0;
}

/** Git, not the run list, proves a first run: expired runs are deleted with their artifacts. */
export function indexJobHistory(cwd = process.cwd(), scopeName = "commit") {
  const { marker } = INDEX_SCOPES[scopeName];
  const gitIn = (args) =>
    spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const hasIndexJob = (sha) => {
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) return false;
    const shown = gitIn(["cat-file", "-p", `${sha}:${marker.file}`]);
    return shown.status === 0 && (marker.text === null || shown.stdout.includes(marker.text));
  };
  return {
    hasIndexJob,
    indexJobPredates(date) {
      const result = gitIn([
        "rev-list",
        "--first-parent",
        "-1",
        `--before=${date.toISOString()}`,
        "HEAD",
      ]);
      return result.status === 0 && hasIndexJob(result.stdout.trim());
    },
  };
}

function githubRequest(apiUrl, token) {
  return async (pathname, query) => {
    const url = new URL(`${apiUrl.replace(/\/+$/, "")}${pathname}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch {
      response = null;
    }
    if (!response?.ok)
      fail("infrastructure-unavailable", "The workflow run history could not be read.");
    return response.json();
  };
}

/** Allowed characters for a public waiver reason, quoted for the gate's own error line. */
const WAIVER_ALLOWED_CHARACTERS = "letters, numbers, spaces, and . , ; : ' \" ( ) ! ? & % + -";

/**
 * One plain sentence per reason. `reports-missing` already reads as a complete, actionable
 * sentence on its own — it is printed as-is, with no "refused this run" framing. `undeclared-budget`
 * does too, except when it actually blocks the run (a comparison that is not tiered by report):
 * there it also names the fix, because the caller prints it as an error rather than a warning.
 */
export function gateErrorLine(reason) {
  if (reason.code === "invalid-waiver")
    return (
      "The evidence waiver was refused because it is not a valid reason: it must be a single " +
      `sentence using only ${WAIVER_ALLOWED_CHARACTERS}, with no slash, "www." host, ` +
      "://scheme, or email address. Rewrite the waiver reason and dispatch again."
    );
  if (reason.code === "reports-missing") return reason.detail;
  if (reason.code === "undeclared-budget")
    return reason.blocks === true
      ? `${reason.detail} Declare that budget in the release policy before this release can pass.`
      : reason.detail;
  const what =
    typeof reason.detail === "string" && reason.detail !== reason.code
      ? reason.detail
      : reason.code.replaceAll("-", " ");
  const scope = reason.scope ? ` (${reason.scope})` : "";
  return `The release gate refused this run: ${what}${scope}. Fix the evidence and run the release again.`;
}

function blank(value) {
  return value && value !== "0".repeat(40) ? value : null;
}

function env(name) {
  const value = process.env[name];
  return typeof value === "string" ? value : "";
}

async function main(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--"))
      fail("invalid-argument", "invalid-argument");
    args[key.slice(2)] = value;
    index += 1;
  }
  if (command === "baseline-decision") {
    const base = args.base;
    const harness =
      (await exists(path.join(base, "apps/web/playwright.performance.config.ts"))) &&
      (await exists(path.join(base, "apps/web/src/lib/performance-proxy.test.tsx")));
    const plan = baselineMeasurementPlan({
      baseHarnessPresent: harness,
      candidateSha: args["candidate-sha"],
      baseSha: args["base-sha"],
    });
    process.stdout.write(plan.measureBaseline ? "measure\n" : `pending:${plan.pendingReason}\n`);
    return;
  }
  if (command === "index-push") {
    const nowValue = args.now || env("SCOREBOARD_NOW");
    const now = nowValue ? new Date(nowValue) : undefined;
    if (now && Number.isNaN(now.getTime())) fail("invalid-timestamp", "invalid-timestamp");
    process.exitCode = await runIndexPush({
      root: args.root || env("SCOREBOARD_ROOT") || SCOREBOARD_INDEX_RELATIVE_PATH,
      commitsFile: args["commits-file"] ?? null,
      // Only a push to dev or main of this repository extends the durable chain and backfills.
      backfill: durableIndexScope({ eventName: env("GITHUB_EVENT_NAME"), ref: env("GITHUB_REF") }),
      base: args.base || env("SCOREBOARD_BASE"),
      head: args.head || env("SCOREBOARD_HEAD"),
      runnerCommit: args["runner-sha"] || env("SCOREBOARD_RUNNER"),
      mode: args.mode || env("SCOREBOARD_MODE") || "commit",
      environment: args.environment || env("SCOREBOARD_ENVIRONMENT") || "ubuntu-24.04-diagnostic",
      suiteVersion: args["suite-version"] || env("SCOREBOARD_SUITE") || "scoreboard-1",
      fixedReleaseCommit: blank(args["fixed-release-sha"] || env("SCOREBOARD_FIXED")),
      pendingReason: args["pending-reason"] || env("SCOREBOARD_PENDING") || undefined,
      now,
    });
    return;
  }
  if (command === "restore-index") {
    await restoreIndex(args.source, args.root, args["missing-reason"], {
      artifact: args.artifact,
      runId: Number(args["run-id"]),
    });
    return;
  }
  if (command === "prior-index") {
    const scope = args.scope ?? "commit";
    if (scope !== "commit" && scope !== "release") fail("invalid-argument", "invalid-argument");
    const ref = env("GITHUB_REF");
    // Every release run of this repository extends the one release chain.
    const durable =
      scope === "release" || durableIndexScope({ eventName: env("GITHUB_EVENT_NAME"), ref });
    let prior = { runId: null, missingReason: "non-durable-check" };
    if (durable) {
      const repository = env("GITHUB_REPOSITORY");
      if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository))
        fail("invalid-repository", "The repository name is invalid.");
      prior = await findPriorIndexArtifact({
        scope,
        repository,
        branch: scope === "commit" ? ref.slice("refs/heads/".length) : null,
        request: githubRequest(env("GITHUB_API_URL") || "https://api.github.com", env("GH_TOKEN")),
        ...indexJobHistory(process.cwd(), scope),
      });
    }
    const artifact = INDEX_SCOPES[scope].artifact;
    process.stdout.write(
      [
        `durable=${durable}`,
        `run_id=${prior.runId ?? ""}`,
        `missing_reason=${prior.missingReason ?? ""}`,
        `artifact_name=${durable ? artifact : `${artifact}-check`}`,
        "",
      ].join("\n"),
    );
    return;
  }
  if (command === "stage-reports") {
    await stagePublicationReports(args.reports, args.directory);
    return;
  }
  if (command === "release-gate") {
    const outputPath = env("SCOREBOARD_OUTPUT") || "scoreboard-publication/gate.json";
    process.exitCode = await runReleaseGate({
      artifactRoot: env("SCOREBOARD_ARTIFACTS") || "release-artifacts",
      reportsRoot: env("SCOREBOARD_REPORTS") || "scoreboard-reports",
      outputPath,
      indexRoot: env("SCOREBOARD_INDEX") || path.join("scoreboard-publication", "index"),
      candidateSha: env("SCOREBOARD_CANDIDATE"),
      baseSha: env("SCOREBOARD_BASE"),
      fixedReleaseSha: env("SCOREBOARD_FIXED"),
      runnerCommit: env("SCOREBOARD_RUNNER"),
      environment: env("SCOREBOARD_ENVIRONMENT") || "release-packaged",
      waiver: env("SCOREBOARD_WAIVER"),
      trigger: env("GITHUB_EVENT_NAME"),
      actor: env("GITHUB_TRIGGERING_ACTOR"),
      runId: /^\d+$/.test(env("GITHUB_RUN_ID")) ? Number(env("GITHUB_RUN_ID")) : null,
    });
    if (process.exitCode) {
      const gate = await readJson(outputPath);
      for (const reason of gate?.reasons ?? []) {
        // A non-blocking undeclared budget is a warning, never an error: it did not refuse the run.
        const warning = reason.code === "undeclared-budget" && reason.blocks !== true;
        const title = warning ? "::warning" : "::error";
        process.stdout.write(`${title} title=Scoreboard release gate::${gateErrorLine(reason)}\n`);
      }
    }
    return;
  }
  if (command === "verify-publication") {
    const gate = await readJson(args.gate);
    if (!gate) fail("invalid-gate", "The publication gate is missing.");
    await verifyPublicationBytes(args.directory, gate);
    return;
  }
  if (command === "list-upload") {
    const files = await publicationFiles(args.directory);
    const listed = files.map((file) => path.join(args.directory, file.name));
    const gate = path.resolve(args.directory, "..", "scoreboard-publication", "gate.json");
    if (await exists(gate)) listed.push(gate);
    process.stdout.write(listed.join("\n"));
    if (listed.length) process.stdout.write("\n");
    return;
  }
  if (command === "report-artifact") {
    const repository = env("GITHUB_REPOSITORY");
    const runId = Number(env("GITHUB_RUN_ID"));
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository))
      fail("invalid-repository", "The repository name is invalid.");
    const present = await reportsArtifactPresent({
      repository,
      runId,
      request: githubRequest(env("GITHUB_API_URL") || "https://api.github.com", env("GH_TOKEN")),
    });
    process.stdout.write(`present=${present}\n`);
    return;
  }
  fail(
    "invalid-argument",
    "Expected baseline-decision, restore-index, prior-index, index-push, stage-reports, release-gate, report-artifact, verify-publication, or list-upload.",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof ScoreboardIndexError ? error.message : "Scoreboard index failed.",
    );
    process.exitCode = 1;
  }
}
