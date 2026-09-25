import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

/** Local historical scoreboard. Workflow artifacts are a transport copy, not this store. */
export const SCOREBOARD_INDEX_RELATIVE_PATH = ".context/performance/scoreboard-index";
export const INDEX_SCHEMA_VERSION = 1;
export const COMMIT_OBJECT_RETENTION_DAYS = 180;
export const WORKFLOW_ARTIFACT_RETENTION_DAYS = 90;
export const RELEASE_EVIDENCE_RETENTION = "github-release-lifetime";
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
  "common-runner-undeclared",
  "release-runner-not-provisioned",
  "baseline-tree-unavailable",
  "reports-missing",
  "infrastructure-unavailable",
  "artifact-digest-mismatch",
  "missing-energy",
  "missing-platform",
  "insufficient-samples",
  "tier-not-releasable",
  "missing-fixed-release",
  "release-commit-mismatch",
  "unmapped-artifact",
]);
const GENESIS = "0".repeat(64);
const RECORD_KEYS = [
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
  "supersedes",
  "expiresRecord",
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
const FAILURE_EXIT_CODES = new Set([
  "artifact-digest-mismatch",
  "safety-failure",
  "budget-regression",
  "required-task-failed",
  "unmapped-artifact",
]);
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
    createPerformanceEvidenceEnvelope: report.createPerformanceEvidenceEnvelope,
    parsePerformanceEvidenceEnvelope: report.parsePerformanceEvidenceEnvelope,
    comparePerformanceEvidence: statistics.comparePerformanceEvidence,
    packagedCoverage: plan.packagedCoverage,
    RELEASE_TARGETS: plan.RELEASE_TARGETS,
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
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(value))
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
function objectPath(root, digestValue) {
  return path.join(root, "objects", digestValue);
}
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function selectCommitRange({ eventName, before, base, head }) {
  sha40(head);
  const zero = "0".repeat(40);
  if (eventName === "pull_request") {
    sha40(base);
    return { kind: "range", base, head };
  }
  if (eventName === "push") {
    if (before === zero) return { kind: "history", head };
    sha40(before);
    return { kind: "range", base: before, head };
  }
  if (eventName === "workflow_dispatch" || eventName === "workflow_call") {
    if (base && base !== zero) {
      sha40(base);
      return { kind: "range", base, head };
    }
    return { kind: "single", head };
  }
  fail("unsupported-event", "unsupported-event");
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

export function baselineMeasurementPlan({ baseHarnessPresent, runnerSha, candidateSha, baseSha }) {
  sha40(runnerSha);
  sha40(candidateSha);
  sha40(baseSha);
  if (typeof baseHarnessPresent !== "boolean") fail("invalid-harness", "invalid-harness");
  const pendingReason = baseHarnessPresent ? null : "benchmark-runner-incompatible";
  return {
    copyProductionIntoBaseline: false,
    independentTrees: ["candidate", "base", "runner"],
    measureBaseline: pendingReason === null,
    pendingReason,
  };
}

export function planEvidenceRecords({ commits, measurements = [], pendingReason }) {
  if (!Array.isArray(commits)) fail("invalid-commits", "invalid-commits");
  if (!PENDING_REASONS.includes(pendingReason)) fail("invalid-reason", "invalid-reason");
  const seen = new Set();
  const supplied = new Map();
  for (const measurement of measurements) {
    sha40(measurement?.commit);
    if (supplied.has(measurement.commit)) fail("duplicate-measurement", "duplicate-measurement");
    if (measurement.pendingReason && !PENDING_REASONS.includes(measurement.pendingReason))
      fail("invalid-reason", "invalid-reason");
    supplied.set(measurement.commit, measurement);
  }
  const planned = commits.map((commit) => {
    sha40(commit?.commit);
    if (commit.parentCommit !== null) sha40(commit.parentCommit);
    if (seen.has(commit.commit)) fail("duplicate-commit", "duplicate-commit");
    seen.add(commit.commit);
    const measurement = supplied.get(commit.commit);
    supplied.delete(commit.commit);
    return {
      commit: commit.commit,
      parentCommit: commit.parentCommit,
      pendingReason: measurement?.pendingReason ?? pendingReason,
      envelope: measurement?.envelope ?? null,
    };
  });
  if (supplied.size) fail("unenumerated-commit", "unenumerated-commit");
  return planned;
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

async function withIndexLock(root, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  await mkdir(root, { recursive: true });
  const lockDir = path.join(root, "lock");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, "owner"), token);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const ownerPath = path.join(lockDir, "owner");
      let stale = false;
      try {
        stale = Date.now() - (await stat(ownerPath)).mtimeMs > staleMs;
      } catch {
        try {
          stale = Date.now() - (await stat(lockDir)).mtimeMs > staleMs;
        } catch {
          stale = false;
        }
      }
      if (stale) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs)
        fail("lock-timeout", "Scoreboard index lock timed out.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      if ((await readFile(path.join(lockDir, "owner"), "utf8")) === token)
        await rm(lockDir, { recursive: true, force: true });
    } catch {
      /* A stale lock was already replaced. */
    }
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

export function evidenceFor(records, selector) {
  const history = records.filter((record) => sameKey(record, selector));
  const measured = history.filter((record) => record.status === "measured");
  const pending = history.filter((record) => record.status === "pending");
  return {
    history,
    current: measured.at(-1) ?? pending.at(-1) ?? null,
    expired: history.some((record) => record.status === "expired"),
    rejections: history.filter((record) => record.status === "rejected").length,
  };
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
      retention: history.some((record) => record.status === "expired") ? "expired" : "current",
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

async function normalizeRecord(input, existing) {
  const scoreboard = await loadScoreboard();
  const publicInput = { ...input };
  delete publicInput.root;
  assertPublicValue(publicInput);
  opaque(input.environment);
  opaque(input.suiteVersion);
  if (input.suiteVersion !== scoreboard.SCOREBOARD_MANIFEST.suiteVersion)
    fail("unsupported-suite", "unsupported-suite");
  const suiteHash = scoreboard.contentDigest(scoreboard.SCOREBOARD_MANIFEST);
  sha40(input.commit);
  if (input.parentCommit !== null) sha40(input.parentCommit);
  if (input.fixedReleaseCommit !== null) sha40(input.fixedReleaseCommit);
  sha40(input.runnerCommit);
  timestamp(input.indexedAt);
  if (!["measured", "pending", "expired", "rejected"].includes(input.status))
    fail("invalid-status", "invalid-status");
  if (!["commit", "release"].includes(input.tier)) fail("invalid-tier", "invalid-tier");
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
    supersedes: input.supersedes,
    expiresRecord: input.expiresRecord ?? null,
    previousHash: existing.at(-1)?.recordHash ?? GENESIS,
  };
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
    if (input.expiresRecord !== undefined && input.expiresRecord !== null)
      fail("invalid-record", "invalid-record");
    body.expiresRecord = null;
  } else if (input.status === "expired") {
    digest(input.expiresRecord);
    body.expiresRecord = input.expiresRecord;
    body.pendingReason = null;
    if (input.objectDigest) {
      digest(input.objectDigest);
      body.objectDigest = input.objectDigest;
    }
    if (input.reportDigest) {
      digest(input.reportDigest);
      body.reportDigest = input.reportDigest;
    }
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
    const digests = Array.isArray(input.artifactDigests) ? input.artifactDigests : [];
    const stored = digests.map((artifact) => {
      exactKeys(artifact, ["name", "sha256", "bytes", "target"], "unsafe-artifact-name");
      artifactName(artifact.name);
      digest(artifact.sha256);
      if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0)
        fail("invalid-digest", "invalid-digest");
      if (artifact.target !== null && !scoreboard.RELEASE_TARGETS.includes(artifact.target))
        fail("unknown-target", "unknown-target");
      return {
        name: artifact.name,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        target: artifact.target,
      };
    });
    stored.sort((left, right) =>
      left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0,
    );
    const buildArtifacts = envelope.report.artifacts.filter(
      (artifact) => artifact.kind === "build",
    );
    if (input.tier === "release" && input.role === "candidate") {
      const left = stored.map((artifact) => `${artifact.sha256}:${artifact.bytes}`).join(",");
      const right = buildArtifacts
        .map((artifact) => `${artifact.sha256}:${artifact.bytes}`)
        .sort()
        .join(",");
      if (!stored.length || left !== right)
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

async function appendLine(root, record, canonicalSerialize) {
  const file = recordsPath(root);
  const handle = await open(file, "a");
  try {
    await handle.write(`${canonicalSerialize(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function appendIndexRecord(root, input, options = {}) {
  return withIndexLock(
    root,
    async () => {
      const existing = await readIndexUnlocked(root);
      const { canonicalSerialize } = await loadScoreboard();
      const record = await normalizeRecord({ ...input, root }, existing);
      await appendLine(root, record, canonicalSerialize);
      return record;
    },
    options,
  );
}

export async function pruneCommitObjects(root, now, retentionDays = COMMIT_OBJECT_RETENTION_DAYS) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    fail("invalid-timestamp", "invalid-timestamp");
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1)
    fail("invalid-retention", "invalid-retention");
  return withIndexLock(root, async () => {
    const existing = await readIndexUnlocked(root);
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const protectedDigests = new Set(
      existing
        .filter((record) => record.tier === "release" && record.objectDigest)
        .map((record) => record.objectDigest),
    );
    const tombstoned = new Set(
      existing
        .filter((record) => record.status === "expired")
        .map((record) => record.expiresRecord),
    );
    const { canonicalSerialize } = await loadScoreboard();
    let removed = 0;
    let records = existing;
    for (const record of existing) {
      if (record.tier !== "commit" || record.status !== "measured" || !record.objectDigest)
        continue;
      if (Date.parse(record.indexedAt) >= cutoff) continue;
      if (protectedDigests.has(record.objectDigest)) continue;
      const file = objectPath(root, record.objectDigest);
      if (!tombstoned.has(record.recordHash)) {
        const tombstone = await normalizeRecord(
          {
            root,
            status: "expired",
            tier: "commit",
            mode: "commit",
            commit: record.commit,
            parentCommit: record.parentCommit,
            fixedReleaseCommit: record.fixedReleaseCommit,
            suiteVersion: record.suiteVersion,
            environment: record.environment,
            environmentHash: record.environmentHash,
            attempt: nextAttempt(records, record),
            role: record.role,
            indexedAt: now.toISOString(),
            runnerCommit: record.runnerCommit,
            supersedes: records.filter((item) => sameKey(item, record)).at(-1)?.recordHash ?? null,
            expiresRecord: record.recordHash,
            objectDigest: record.objectDigest,
            reportDigest: record.reportDigest,
          },
          records,
        );
        await appendLine(root, tombstone, canonicalSerialize);
        records = [...records, tombstone];
        tombstoned.add(record.recordHash);
      }
      if (await exists(file)) {
        await rm(file);
        removed += 1;
      }
    }
    return { removed, records: records.length };
  });
}

function installerRank(name) {
  const extensions = [".dmg", ".exe", ".AppImage", ".deb", ".zip"];
  const index = extensions.findIndex((extension) => name.endsWith(extension));
  return index === -1 ? extensions.length : index;
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
    const [directory, ...rest] = entry.path.split("/");
    const target = DIRECTORY_TARGETS[directory];
    if (!target || rest.length !== 1) fail("unmapped-artifact", "unmapped-artifact");
    artifactName(rest[0]);
    files.push({ target, name: rest[0], sha256: entry.sha256, bytes: entry.bytes });
  }
  if (new Set(files.map((file) => file.sha256)).size !== files.length)
    fail("artifact-digest-mismatch", "artifact-digest-mismatch");
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

async function validatedEnergy(file, primaries) {
  if (!(await exists(file))) return new Set();
  const { ingestPhysicalEnergy } = await loadScoreboard();
  let entries;
  try {
    entries = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return new Set();
  }
  if (!Array.isArray(entries)) return new Set();
  const observed = new Set();
  for (const entry of entries) {
    try {
      exactKeys(entry, ["target", "capture", "idle"], "missing-energy");
      assertPublicValue(entry);
      const primary = primaries.find((item) => item.target === entry.target);
      const platform = TARGET_PLATFORM[entry.target];
      if (!primary || !platform || observed.has(entry.target)) continue;
      const result = ingestPhysicalEnergy(
        entry.capture,
        {
          ...entry.capture.binding,
          artifactHash: primary.sha256,
          platform,
        },
        entry.idle,
      );
      if (result.scope === "cpu-package" || result.systemEnergy?.missingReason) continue;
      observed.add(entry.target);
    } catch {
      /* This target stays not-measured and blocks a required gate. */
    }
  }
  return observed;
}

function rowFromComparison(comparison) {
  const estimate = comparison.estimate;
  return {
    metricId: comparison.metricId,
    baseline: comparison.baseline,
    outcome: comparison.outcome,
    statistic: comparison.statistic,
    samples: estimate?.samplePairs ?? null,
    estimate: estimate?.after.value ?? null,
    interval: estimate
      ? { lower: estimate.after.interval.lower, upper: estimate.after.interval.upper }
      : null,
    delta: estimate?.degradation.value ?? null,
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

function safetySummary(report) {
  const safety = report.metrics.filter((metric) =>
    [
      "m13.wrong-pin",
      "m13.unauthorized-effects",
      "m13.duplicate-effects",
      "m13.lost-accepted-work",
      "m13.false-completion",
      "m11.lazy-boundary-violations",
    ].includes(metric.id),
  );
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
  return complete
    .map(
      (crash) =>
        `${crash.id} ${crash.recovery} safety ${crash.safetyPassed} completed ${crash.taskCompleted}`,
    )
    .join("; ");
}

export async function evaluatePublicationGate(input) {
  const scoreboard = await loadScoreboard();
  const reasons = [];
  const unknowns = ["startup strata: not measured by this gate"];
  const push = (code, scope, detail = code) => {
    let text = typeof detail === "string" ? detail : code;
    if (text.length > 240 || PRIVATE_MARKERS.some((marker) => text.includes(marker))) text = code;
    reasons.push({ code, scope, detail: text });
  };
  if (input.unmapped) push("unmapped-artifact", "artifacts");
  let verdict = null;
  let candidateReport = null;
  if (!input.parent || !input.candidate || !input.fixedRelease || !input.policy) {
    push("reports-missing", "reports");
  } else {
    verdict = scoreboard.comparePerformanceEvidence({
      policy: input.policy,
      parent: input.parent,
      candidate: input.candidate,
      fixedRelease: input.fixedRelease,
    });
    for (const reason of verdict.reasons) push(reason.code, reason.scope, reason.detail);
    candidateReport = verdict.evidence?.candidate.report ?? null;
  }
  const files = input.files ?? [];
  assertPublicValue(
    files.map(({ target, name, sha256: digestValue, bytes }) => ({
      target,
      name,
      sha256: digestValue,
      bytes,
    })),
  );
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
  let observedSamples = null;
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
    const floor =
      candidateReport.scenario.tier === "T2"
        ? scoreboard.SCOREBOARD_MANIFEST.samplePlan.releaseStartupObservationsPerStratum
        : scoreboard.SCOREBOARD_MANIFEST.samplePlan.releaseReplayPairs;
    const requiredIds = Array.isArray(input.policy?.policy?.required?.metricIds)
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
    const buildArtifacts = candidateReport.artifacts.filter(
      (artifact) => artifact.kind === "build",
    );
    const left = files
      .map((file) => `${file.sha256}:${file.bytes}`)
      .sort()
      .join(",");
    const right = buildArtifacts
      .map((artifact) => `${artifact.sha256}:${artifact.bytes}`)
      .sort()
      .join(",");
    if (!files.length || left !== right) push("artifact-digest-mismatch", "artifacts");
  }
  const unique = [];
  for (const reason of reasons) {
    if (!unique.some((item) => item.code === reason.code && item.scope === reason.scope))
      unique.push(reason);
  }
  const releaseEligible = verdict?.releaseEligible === true;
  const allowPublication = releaseEligible && unique.length === 0;
  const exitCode = allowPublication
    ? 0
    : unique.some((reason) => FAILURE_EXIT_CODES.has(reason.code)) || verdict?.exitCode === 1
      ? 1
      : 2;
  const plan = await samplePlanFor("release");
  const rows = (verdict?.comparisons ?? [])
    .map(rowFromComparison)
    .sort((left, right) =>
      `${left.metricId}:${left.baseline}:${left.outcome}:${left.statistic}`.localeCompare(
        `${right.metricId}:${right.baseline}:${right.outcome}:${right.statistic}`,
      ),
    );
  const summaries = candidateReport
    ? {
        taskSummary: taskSummary(candidateReport),
        safetySummary: safetySummary(candidateReport),
        recoverySummary: recoverySummary(candidateReport),
        tokensSummary: candidateReport.usage.length
          ? `${candidateReport.usage.length} requests`
          : "unknown",
        cacheSummary: metricSummary(candidateReport, "m05."),
        compactionSummary: metricSummary(candidateReport, "m06."),
        memorySummary: metricSummary(candidateReport, "m10."),
        bundleSummary: metricSummary(candidateReport, "m11."),
      }
    : {
        taskSummary: "unknown",
        safetySummary: "unknown",
        recoverySummary: "unknown",
        tokensSummary: "unknown",
        cacheSummary: "unknown",
        compactionSummary: "unknown",
        memorySummary: "unknown",
        bundleSummary: "unknown",
      };
  for (const summary of Object.values(summaries))
    if (summary === "unknown" || summary.includes("unknown")) unknowns.push(summary);
  const requiredEnergy = REQUIRED_RELEASE_TARGETS.filter(
    (target) => coverage.find((cell) => cell.target === target)?.energy === "observed",
  );
  const gate = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    allowPublication,
    exitCode,
    reasons: unique,
    unknowns: [...new Set(unknowns)],
    humanAcceptance: "separate",
    suiteVersion: scoreboard.SCOREBOARD_MANIFEST.suiteVersion,
    suiteHash: scoreboard.contentDigest(scoreboard.SCOREBOARD_MANIFEST),
    environment: input.environment,
    samplePlan: plan.label,
    declaredSamples: plan.declaredSamples,
    observedSamples,
    calibration: verdict?.calibration ?? "missing",
    policyHash: verdict?.policyHash ?? null,
    verdictStatus: verdict?.status ?? "missing",
    rows,
    ...summaries,
    energySummary:
      requiredEnergy.length === REQUIRED_RELEASE_TARGETS.length
        ? `observed on ${requiredEnergy.join(", ")}`
        : "unknown",
    rawObjectDigest: verdict?.evidence?.candidate.sha256 ?? null,
    distributedDigests: files.map(({ target, name, sha256: digestValue, bytes }) => ({
      target,
      name,
      sha256: digestValue,
      bytes,
    })),
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

export function renderScoreboardNotes(gate) {
  exactKeys(
    gate,
    [
      "schemaVersion",
      "allowPublication",
      "exitCode",
      "reasons",
      "unknowns",
      "humanAcceptance",
      "suiteVersion",
      "suiteHash",
      "environment",
      "samplePlan",
      "declaredSamples",
      "observedSamples",
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
      "energySummary",
      "rawObjectDigest",
      "distributedDigests",
      "coverage",
      "releaseEligible",
    ],
    "invalid-gate",
  );
  if (
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
    `Suite ${gate.suiteVersion} (${gate.suiteHash}).`,
    `Environment ${gate.environment}.`,
    `Sample plan ${gate.samplePlan}: ${gate.declaredSamples.pairs} paired observations; startup per stratum ${cell(gate.declaredSamples.startupPerStratum)}. Observed samples: ${cell(gate.observedSamples)}.`,
    `Policy ${gate.calibration} ${cell(gate.policyHash)}. Verdict ${gate.verdictStatus}.`,
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
  lines.push(
    "",
    `Task success: ${gate.taskSummary}.`,
    `Critical safety: ${gate.safetySummary}.`,
    `Recovery: ${gate.recoverySummary}.`,
    `Tokens: ${gate.tokensSummary}.`,
    `Cache: ${gate.cacheSummary}.`,
    `Compaction: ${gate.compactionSummary}.`,
    `Memory: ${gate.memorySummary}.`,
    `Bundles: ${gate.bundleSummary}.`,
    `Energy: ${gate.energySummary}.`,
    "",
    "Unknowns:",
  );
  if (!gate.unknowns.length) lines.push("- none");
  for (const unknown of gate.unknowns) lines.push(`- ${unknown}`);
  lines.push(
    "",
    `Raw evidence object ${cell(gate.rawObjectDigest)}.`,
    `Budget decision: ${gate.verdictStatus} (${cell(gate.policyHash)}).`,
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

async function appendVisible(root, input) {
  try {
    return await appendIndexRecord(root, input);
  } catch (error) {
    if (error instanceof ScoreboardIndexError && error.code === "pending-hides-measurement")
      return null;
    throw error;
  }
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
  const primaries = primaryInstallers(files);
  let energyTargets = new Set();
  const energyFile = path.join(options.reportsRoot, "energy.json");
  if (await exists(energyFile)) energyTargets = await validatedEnergy(energyFile, primaries);
  const names = ["parent.json", "candidate.json", "fixed-release.json", "policy.json"];
  const [parent, candidate, fixedRelease, policy] = await Promise.all(
    names.map((name) => readJson(path.join(options.reportsRoot, name))),
  );
  const gate = await evaluatePublicationGate({
    parent,
    candidate,
    fixedRelease,
    policy,
    files,
    energyTargets,
    unmapped,
    candidateSha: options.candidateSha,
    baseSha: options.baseSha,
    fixedReleaseSha: options.fixedReleaseSha || null,
    environment: options.environment,
  });
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${scoreboard.canonicalSerialize(gate)}\n`);
  const indexedAt = options.indexedAt ?? new Date().toISOString();
  const common = {
    tier: "release",
    mode: "release",
    suiteVersion: gate.suiteVersion,
    environment: options.environment,
    environmentHash: candidate?.report?.environmentHash ?? null,
    indexedAt,
    runnerCommit: options.runnerCommit,
    fixedReleaseCommit: options.fixedReleaseSha || null,
    root: options.indexRoot,
  };
  if (!gate.allowPublication) {
    const reason = PENDING_REASONS.includes(gate.reasons[0]?.code)
      ? gate.reasons[0].code
      : "reports-missing";
    if (options.candidateSha && /^[a-f0-9]{40}$/.test(options.candidateSha)) {
      const records = await readIndex(options.indexRoot);
      const key = {
        commit: options.candidateSha,
        suiteHash: gate.suiteHash,
        environment: options.environment,
        role: "candidate",
        tier: "release",
      };
      const prior = records.filter((record) => sameKey(record, key));
      await appendVisible(options.indexRoot, {
        ...common,
        status: prior.some((record) => record.status === "measured") ? "rejected" : "pending",
        commit: options.candidateSha,
        parentCommit: /^[a-f0-9]{40}$/.test(options.baseSha ?? "") ? options.baseSha : null,
        role: "candidate",
        attempt: nextAttempt(records, key),
        supersedes: prior.at(-1)?.recordHash ?? null,
        pendingReason: reason,
      });
    }
    return gate.exitCode;
  }
  const roles = [
    ["candidate", candidate, options.candidateSha, files.map((file) => ({ ...file }))],
    ["parent", parent, options.baseSha, []],
    ["fixed-release", fixedRelease, options.fixedReleaseSha, []],
  ];
  let records = await readIndex(options.indexRoot);
  for (const [role, envelope, commit, digests] of roles) {
    const key = {
      commit,
      suiteHash: gate.suiteHash,
      environment: options.environment,
      role,
      tier: "release",
    };
    const prior = records.filter((record) => sameKey(record, key));
    const record = await appendIndexRecord(options.indexRoot, {
      ...common,
      status: "measured",
      role,
      commit,
      parentCommit: envelope.report.build.parentCommit,
      fixedReleaseCommit: envelope.report.build.fixedReleaseCommit,
      attempt: nextAttempt(records, key),
      supersedes: prior.at(-1)?.recordHash ?? null,
      envelope,
      artifactDigests: digests,
      verdictDigest: gate.policyHash,
    });
    records = [...records, record];
  }
  return 0;
}

export async function runIndexPush(options) {
  const scoreboard = await loadScoreboard();
  let commits = options.commits ?? null;
  if (!commits && options.commitsFile) {
    const parsed = JSON.parse(await readFile(options.commitsFile, "utf8"));
    if (!Array.isArray(parsed)) fail("invalid-commits", "invalid-commits");
    commits = parsed;
  }
  if (!commits) {
    const range = selectCommitRange({
      eventName: options.eventName,
      before: options.before,
      base: options.base,
      head: options.head,
    });
    try {
      if (range.kind === "single") {
        let parentCommit = null;
        try {
          const parent = execFileSync("git", ["rev-parse", `${range.head}^`], {
            encoding: "utf8",
          }).trim();
          if (/^[a-f0-9]{40}$/.test(parent)) parentCommit = parent;
        } catch {
          parentCommit = null;
        }
        commits = [{ commit: range.head, parentCommit }];
      } else if (range.kind === "history") {
        commits = parseRevListParents(
          execFileSync("git", ["rev-list", "--reverse", "--parents", range.head], {
            encoding: "utf8",
          }),
        );
      } else {
        commits = parseRevListParents(
          execFileSync(
            "git",
            ["rev-list", "--reverse", "--parents", `${range.base}..${range.head}`],
            { encoding: "utf8" },
          ),
        );
      }
    } catch (error) {
      if (error instanceof ScoreboardIndexError) throw error;
      fail("infrastructure-unavailable", "The commit range could not be read.");
    }
  }
  const planned = planEvidenceRecords({
    commits,
    measurements: options.measurements ?? [],
    pendingReason: options.pendingReason ?? "schema-3-evidence-not-produced",
  });
  const indexedAt = options.indexedAt ?? new Date().toISOString();
  let records = await readIndex(options.root);
  for (const item of planned) {
    const mode = options.mode ?? "commit";
    const key = {
      commit: item.commit,
      suiteHash: scoreboard.contentDigest(scoreboard.SCOREBOARD_MANIFEST),
      environment: options.environment,
      role: "candidate",
      tier: mode === "release" ? "release" : "commit",
    };
    const prior = records.filter((record) => sameKey(record, key));
    const record = await appendIndexRecord(options.root, {
      status: item.envelope
        ? "measured"
        : prior.some((entry) => entry.status === "measured")
          ? "rejected"
          : "pending",
      tier: key.tier,
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
      attempt: nextAttempt(records, key),
      supersedes: prior.at(-1)?.recordHash ?? null,
      pendingReason: item.pendingReason,
      envelope: item.envelope,
    });
    records = [...records, record];
  }
  const audit = auditCommits(
    records,
    planned.map((item) => ({ commit: item.commit })),
  );
  return audit.complete ? 0 : 1;
}

function jobBlock(yaml, name) {
  const marker = `\n  ${name}:\n`;
  const start = yaml.indexOf(marker);
  if (start < 0) fail("invalid-workflow", `missing job ${name}`);
  const rest = yaml.slice(start + marker.length);
  const next = rest.search(/\n {2}[a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

export function assertWorkflowContracts(performanceText, releaseText) {
  const errors = [];
  const requireText = (value, needle, label) => {
    if (!value.includes(needle)) errors.push(label);
  };
  requireText(performanceText, "workflow_call:", "performance workflow_call");
  for (const input of [
    "candidate_sha:",
    "base_sha:",
    "suite_version:",
    "environment:",
    "common_runner_sha:",
    "mode:",
    "gate:",
  ])
    requireText(performanceText, input, `performance input ${input}`);
  requireText(performanceText, "cancel-in-progress: false", "performance must not cancel evidence");
  if (performanceText.includes("cancel-in-progress: true")) errors.push("performance cancels runs");
  if (performanceText.includes("ShellSkeleton.tsx") || /\bcp\b/.test(performanceText))
    errors.push("performance copies candidate code into the baseline");
  if (performanceText.includes("secrets.")) errors.push("performance workflow uses secrets");
  requireText(performanceText, "node scripts/scoreboard-index.mjs index-push", "index-push");
  requireText(
    performanceText,
    "node scripts/scoreboard-index.mjs baseline-decision",
    "baseline-decision",
  );
  requireText(performanceText, "node scripts/scoreboard-index.mjs release-gate", "release-gate");
  requireText(performanceText, "retention-days: 90", "artifact retention");
  requireText(
    performanceText,
    "Measure current revision and retain traces",
    "advisory measurement",
  );
  requireText(performanceText, "persist-credentials: false", "credential-free checkout");
  requireText(performanceText, ".context/performance/scoreboard-index", "index path");
  const releaseGate = jobBlock(performanceText, "release-gate");
  requireText(
    releaseGate,
    "github.event_name == 'workflow_call' && inputs.gate == 'required'",
    "required gate condition",
  );
  const gateCommand = releaseGate.split("node scripts/scoreboard-index.mjs release-gate")[0] ?? "";
  if (gateCommand.split("\n").slice(-8).join("\n").includes("continue-on-error"))
    errors.push("release gate continues on error");
  const evidence = jobBlock(releaseText, "evidence");
  requireText(evidence, "uses: ./.github/workflows/performance.yml", "release invokes performance");
  requireText(evidence, "gate: required", "release gate is required");
  requireText(evidence, "needs: [validate, build]", "evidence follows packaging");
  if (evidence.includes("continue-on-error") || evidence.includes("gh release create"))
    errors.push("evidence job bypasses the gate");
  const publish = jobBlock(releaseText, "publish");
  requireText(publish, "needs: [validate, build, evidence]", "publish needs evidence");
  requireText(publish, "scoreboard-publication/gate.json", "notes bind the gate");
  if ((publish.match(/gh release create/g) ?? []).length !== 1)
    errors.push("unexpected publish command");
  requireText(releaseText, "cancel-in-progress: false", "release must not cancel publication");
  if (errors.length) fail("invalid-workflow", errors.join("; "));
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
      runnerSha: args["runner-sha"],
      candidateSha: args["candidate-sha"],
      baseSha: args["base-sha"],
    });
    if (plan.copyProductionIntoBaseline) fail("production-copy", "production-copy");
    process.stdout.write(plan.measureBaseline ? "measure\n" : `pending:${plan.pendingReason}\n`);
    return;
  }
  if (command === "index-push") {
    process.exitCode = await runIndexPush({
      root: args.root || env("SCOREBOARD_ROOT") || SCOREBOARD_INDEX_RELATIVE_PATH,
      commitsFile: args["commits-file"] ?? null,
      eventName: env("SCOREBOARD_EVENT") || "push",
      before: env("SCOREBOARD_BEFORE"),
      base: args.base || env("SCOREBOARD_BASE"),
      head: args.head || env("SCOREBOARD_HEAD"),
      runnerCommit: args["runner-sha"] || env("SCOREBOARD_RUNNER"),
      mode: args.mode || env("SCOREBOARD_MODE") || "commit",
      environment: args.environment || env("SCOREBOARD_ENVIRONMENT") || "ubuntu-24.04-diagnostic",
      suiteVersion: args["suite-version"] || env("SCOREBOARD_SUITE") || "scoreboard-1",
      fixedReleaseCommit: blank(args["fixed-release-sha"] || env("SCOREBOARD_FIXED")),
    });
    return;
  }
  if (command === "release-gate") {
    process.exitCode = await runReleaseGate({
      artifactRoot: env("SCOREBOARD_ARTIFACTS") || "release-artifacts",
      reportsRoot: env("SCOREBOARD_REPORTS") || "scoreboard-reports",
      outputPath: env("SCOREBOARD_OUTPUT") || "scoreboard-publication/gate.json",
      indexRoot: env("SCOREBOARD_INDEX") || path.join("scoreboard-publication", "index"),
      candidateSha: env("SCOREBOARD_CANDIDATE"),
      baseSha: env("SCOREBOARD_BASE"),
      fixedReleaseSha: env("SCOREBOARD_FIXED"),
      runnerCommit: env("SCOREBOARD_RUNNER"),
      environment: env("SCOREBOARD_ENVIRONMENT") || "release-packaged",
    });
    return;
  }
  if (command === "check-workflows") {
    assertWorkflowContracts(
      await readFile(".github/workflows/performance.yml", "utf8"),
      await readFile(".github/workflows/release-desktop.yml", "utf8"),
    );
    return;
  }
  fail(
    "invalid-argument",
    "Expected baseline-decision, index-push, release-gate, or check-workflows.",
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
