import type { DocumentRevision, LearningObservation } from "@ardurbot/contracts";
import { RuntimePinSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";

const DAY = 86400000;
type FailureClass = keyof LearningObservation["failuresAfter"];
export interface ObservationRun {
  id: string;
  botId: string;
  pin: string | null;
  taskClass: string;
  startedAt: Date;
  completedAt: Date | null;
  status: string;
  feedback: Array<{
    id: string;
    at: Date;
    rating: string;
    reason: string | null;
    retracted: boolean;
  }>;
  steering: Array<{ id: string; at: Date; kind: string; human: boolean }>;
  denials: Array<{ id: string; at: Date; classification: "inappropriate" | "safety" | "unknown" }>;
  failures: Array<{ at: Date; classification: FailureClass }>;
  tokens: number | null;
  // Only a persisted human/deterministic task contract may populate this field.
  acceptance?: { accepted: boolean | null };
}
export interface ObservationExposure {
  runId: string;
  revisionId: string;
  at: Date;
  truncated: boolean;
}
export function observationWindow(createdAt: Date, now: Date) {
  const to = new Date(Math.max(createdAt.getTime(), now.getTime()));
  const from = new Date(Math.max(createdAt.getTime(), to.getTime() - 30 * DAY));
  return { from, to, beforeFrom: new Date(createdAt.getTime() - (to.getTime() - from.getTime())) };
}
/** One denominator entry per terminal run, regardless of attempts or repeated reads. */
export function projectLearningObservation(input: {
  documentId: string;
  revisionId: string;
  createdAt: Date;
  now: Date;
  runs: ObservationRun[];
  exposures: ObservationExposure[];
}): LearningObservation {
  const { from, to, beforeFrom } = observationWindow(input.createdAt, input.now);
  const window = { from: from.toISOString(), to: to.toISOString() };
  const exposures = input.exposures.filter(
    (e) => e.revisionId === input.revisionId && e.at >= from && e.at < to,
  );
  const first = new Map<string, Date>();
  for (const e of exposures)
    if (!first.has(e.runId) || e.at < first.get(e.runId)!) first.set(e.runId, e.at);
  const after = input.runs.filter(
    (r) =>
      first.has(r.id) &&
      r.completedAt &&
      r.completedAt >= first.get(r.id)! &&
      r.completedAt < to &&
      ["completed", "failed", "cancelled"].includes(r.status),
  );
  const comparableKey = (r: ObservationRun) =>
    r.pin ? JSON.stringify([r.botId, r.pin, r.taskClass]) : null;
  const keys = new Set(after.map(comparableKey).filter((k) => k !== null));
  const before = input.runs.filter(
    (r) =>
      r.startedAt >= beforeFrom &&
      r.completedAt &&
      r.completedAt < input.createdAt &&
      ["completed", "failed", "cancelled"].includes(r.status) &&
      keys.has(comparableKey(r)!),
  );
  function corrections(runs: ObservationRun[], lower: (r: ObservationRun) => Date, upper: Date) {
    return {
      feedback: new Set(
        runs.flatMap((r) =>
          r.feedback
            .filter(
              (f) =>
                !f.retracted &&
                f.rating === "negative" &&
                !!f.reason?.trim() &&
                f.at >= lower(r) &&
                f.at < upper,
            )
            .map((f) => f.id),
        ),
      ).size,
      steering: new Set(
        runs.flatMap((r) =>
          r.steering
            .filter((s) => s.human && s.kind === "correction" && s.at >= lower(r) && s.at < upper)
            .map((s) => s.id),
        ),
      ).size,
    };
  }
  const failuresAfter: LearningObservation["failuresAfter"] = {
    task: 0,
    integration: 0,
    provider: 0,
    pin: 0,
    unknown: 0,
  };
  const denialsAfter: LearningObservation["denialsAfter"] = {
    inappropriate: 0,
    safety: 0,
    unknown: 0,
  };
  for (const r of after) {
    const classes = new Set(
      r.failures.filter((f) => f.at >= first.get(r.id)! && f.at < to).map((f) => f.classification),
    );
    if (r.status === "failed" && !classes.size) classes.add("unknown");
    for (const kind of classes) failuresAfter[kind]++;
    for (const d of r.denials.filter((d) => d.at >= first.get(r.id)! && d.at < to))
      denialsAfter[d.classification]++;
  }
  const pairedAfter = after.filter(
    (r) => comparableKey(r) !== null && before.some((b) => comparableKey(b) === comparableKey(r)),
  );
  const delta = (select: (r: ObservationRun) => number | null) => {
    const a = pairedAfter.map(select).filter((n): n is number => n !== null);
    const b = before.map(select).filter((n): n is number => n !== null);
    const mean = (xs: number[]) =>
      xs.length ? Math.round(xs.reduce((sum, n) => sum + n, 0) / xs.length) : null;
    const beforeMean = mean(b),
      afterMean = mean(a);
    return {
      beforeSamples: b.length,
      afterSamples: a.length,
      beforeMean,
      afterMean,
      delta: a.length >= 5 && b.length >= 5 ? afterMean! - beforeMean! : null,
    };
  };
  const missing = [
    "No feedback is not approval. Exposure does not show that the revision was followed.",
    "Task class uses trigger and routine identity; task difficulty and simultaneous changes are not controlled.",
    "Time includes waiting; waiting-time coverage is unavailable. Pricing and review/curator overhead are not a monetary estimate.",
    "Tool audits are best effort; absence of an error is not proof of complete coverage.",
  ];
  if (pairedAfter.length < after.length)
    missing.push(
      "Some exposed pin/task classes have no before match; the curator cannot compare this mixture.",
    );
  if (first.size > after.length)
    missing.push(
      `${first.size - after.length} exposed runs are unfinished or outside the terminal window.`,
    );
  if (after.some((r) => !r.pin))
    missing.push("Some exposed runs have no complete runtime pin and cannot be compared.");
  if (exposures.some((e) => e.truncated)) missing.push("Some exposures were truncated.");
  if (denialsAfter.unknown)
    missing.push(
      "Denial reasons are not classified; inappropriate requests and safety denials share the unknown bucket.",
    );
  if (failuresAfter.unknown)
    missing.push("Some failures have no recorded class; they are not counted as task failures.");
  const noUsage = [...before, ...after].filter((r) => r.tokens === null).length;
  if (noUsage)
    missing.push(`${noUsage} runs have no usage record; missing usage is not zero tokens.`);
  const contracts = after.filter((r) => r.acceptance);
  if (contracts.length < after.length || !contracts.length)
    missing.push(
      "Task-contract acceptance is unavailable for some or all runs. Completion and positive feedback are not acceptance.",
    );
  if (after.length < 5 || before.length < 5) missing.push("Not enough runs to tell");
  return {
    documentId: input.documentId,
    revisionId: input.revisionId,
    exposedRuns: after.length,
    correctionsAfter: corrections(after, (r) => first.get(r.id)!, to),
    before: {
      runs: before.length,
      comparableExposedRuns: pairedAfter.length,
      corrections: corrections(before, (r) => r.startedAt, input.createdAt),
      window: { from: beforeFrom.toISOString(), to: input.createdAt.toISOString() },
    },
    denialsAfter,
    failuresAfter,
    cancellationsAfter: after.filter((r) => r.status === "cancelled").length,
    timeTokensDelta: {
      tokens: delta((r) => r.tokens),
      timeMs: delta((r) =>
        r.completedAt ? r.completedAt.getTime() - r.startedAt.getTime() : null,
      ),
    },
    acceptance: {
      contracts: contracts.length,
      evaluated: contracts.filter((r) => r.acceptance!.accepted !== null).length,
      accepted: contracts.filter((r) => r.acceptance!.accepted === true).length,
    },
    window,
    missing,
  };
}
export function observationPin(value: unknown): string | null {
  const pin = RuntimePinSchema.safeParse(value);
  if (!pin.success || !pin.data.provider || !pin.data.modelId) return null;
  return JSON.stringify(Object.entries(pin.data).sort(([a], [b]) => a.localeCompare(b)));
}
export function learningFailureClass(type: string, value: unknown): FailureClass | null {
  if (!value || typeof value !== "object") return type === "run.failed" ? "unknown" : null;
  const p = value as Record<string, unknown>;
  if (type === "run.failed") {
    if (p.runtimeProblem) return "pin";
    if (["auth", "model-unavailable", "rate-limit"].includes(String(p.providerErrorKind)))
      return "provider";
  } else if (p.outcome !== "error") return null;
  return ["task", "integration", "provider", "pin"].includes(String(p.errorClass))
    ? (p.errorClass as FailureClass)
    : "unknown";
}
export async function observeLearningRevision(
  prisma: PrismaClient,
  revision: DocumentRevision,
  now = new Date(),
): Promise<LearningObservation> {
  const scope = revision.scopeKey;
  const revisionId = `${revision.documentId}:${revision.revision}`;
  const { from, to, beforeFrom } = observationWindow(new Date(revision.createdAt), now);
  const identity = {
    spaceId: scope.spaceId,
    ...(scope.kind !== "space-shared" ? { userId: scope.userId } : {}),
    ...(scope.kind === "bot" ? { botId: scope.botId } : {}),
  };
  const exposures = await prisma.runKnowledgeExposure.findMany({
    where: {
      revisionId,
      documentId: revision.documentId,
      thread: {
        spaceId: scope.spaceId,
        ...(scope.kind !== "space-shared" ? { userId: scope.userId } : {}),
      },
      createdAt: { gte: from, lt: to },
    },
  });
  const rows = await prisma.run.findMany({
    where: {
      ...identity,
      OR: [
        { startedAt: { gte: beforeFrom, lt: to } },
        { startedAt: null, createdAt: { gte: beforeFrom, lt: to } },
        { id: { in: [...new Set(exposures.map((e) => e.runId))] } },
      ],
    },
    include: { usageRecords: true },
  });
  const runIds = rows.map((r) => r.id);
  const [feedback, steering, events, denials] = await Promise.all([
    prisma.feedback.findMany({ where: { spaceId: scope.spaceId, runId: { in: runIds } } }),
    prisma.steeringSummary.findMany({ where: { spaceId: scope.spaceId, runId: { in: runIds } } }),
    prisma.event.findMany({
      where: {
        spaceId: scope.spaceId,
        runId: { in: runIds },
        type: { in: ["run.failed", "agent.tool.completed"] },
      },
    }),
    prisma.externalEffect.findMany({
      where: { spaceId: scope.spaceId, runId: { in: runIds }, status: "denied" },
    }),
  ]);
  return projectLearningObservation({
    documentId: revision.documentId,
    revisionId,
    createdAt: new Date(revision.createdAt),
    now,
    exposures: exposures
      .filter((e) => runIds.includes(e.runId))
      .map((e) => ({ ...e, at: e.createdAt })),
    runs: rows.map((r) => ({
      id: r.id,
      botId: r.botId,
      pin: observationPin(r.runtimePin),
      taskClass: JSON.stringify([r.trigger, r.routineId]),
      startedAt: r.startedAt ?? r.createdAt,
      completedAt: r.completedAt,
      status: r.status,
      feedback: feedback
        .filter((f) => f.runId === r.id)
        .map((f) => ({ ...f, at: f.updatedAt, retracted: !!f.retractedAt })),
      steering: steering
        .filter((s) => s.runId === r.id)
        .map((s) => ({ ...s, at: s.createdAt, human: s.origin === "human-typed" && !!s.actorId })),
      denials: denials
        .filter((d) => d.runId === r.id)
        .map((d) => ({
          id: d.id,
          at: d.decisionAt ?? d.updatedAt,
          classification: "unknown" as const,
        })),
      failures: events
        .filter((e) => e.runId === r.id)
        .flatMap((e) => {
          const classification = learningFailureClass(e.type, e.payload);
          return classification ? [{ at: e.createdAt, classification }] : [];
        }),
      tokens: r.usageRecords.length
        ? r.usageRecords.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0)
        : null,
    })),
  });
}
