import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { LearningInsight } from "@ardurbot/contracts";
import {
  InsightActionSchema,
  InsightEvidenceSchema,
  LocalityPolicySchema,
  ModelDestinationSchema,
  RuntimePinSchema,
  SPACE_INSIGHT_KINDS,
} from "@ardurbot/contracts";
import {
  APPROVAL_WINDOW_DAYS,
  allowsModelDestination,
  computeInsights,
  INSIGHT_RUN_WINDOW_DAYS,
  INSIGHT_SUPPRESSION_DAYS,
  type InsightFacts,
  type InsightModelFact,
  type InsightPin,
  type InsightRunFact,
  insightFailureClass,
  insightImpact,
  insightModelKey,
  LEARNING_OFF_WINDOW_DAYS,
  MAX_ACTIVE_INSIGHTS,
  ROUTINE_WINDOW_DAYS,
  reconcileInsights,
  redactLearningText,
} from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { IsolationError, Prisma } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider.js";
import { listPiCatalog, piModelContextWindow } from "./pi-models.js";

type Identity = { spaceId: string; userId: string };
const DAY_MS = 86_400_000;
/** A run completion or feedback schedules one pass this far ahead; later triggers join it. */
export const INSIGHTS_DEBOUNCE_MS = 15 * 60_000;
const LOCAL_PROVIDERS = new Set(["ollama", LOCAL_PROVIDER_ID]);

function isOwner(role: string | undefined) {
  return !!role
    ?.split(",")
    .map((value) => value.trim())
    .includes("owner");
}

function chunks<T>(values: T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function pinOf(value: unknown): InsightPin | null {
  const pin = RuntimePinSchema.safeParse(value);
  if (!pin.success) return null;
  const { runtimeKind, provider, modelId, effort, credentialId } = pin.data;
  return { runtimeKind, provider, modelId, effort, credentialId };
}

let catalogLabels: Map<string, string> | undefined;
function modelLabel(pin: InsightPin): string {
  catalogLabels ??= new Map(
    listPiCatalog().map((entry) => [`${entry.provider}|${entry.id}`, entry.label]),
  );
  const label = catalogLabels.get(`${pin.provider}|${pin.modelId}`) ?? pin.modelId ?? "";
  return pin.effort ? `${label} · ${pin.effort}` : label;
}

/**
 * The person's own recorded runs, usage, feedback, approvals and settings in this space. Nothing
 * here calls a model or leaves the machine. Space setup facts are loaded only for the owner.
 */
export async function loadInsightFacts(
  prisma: PrismaClient,
  identity: Identity,
  options: { owner: boolean; learningEnabled: boolean },
  now = new Date(),
): Promise<InsightFacts> {
  const { spaceId, userId } = identity;
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const [bots, space, runs, preferences, feedbackReasons, approvals, allowRules, tasks, routines] =
    await Promise.all([
      prisma.bot.findMany({
        where: { spaceId, userId, archivedAt: null },
        select: {
          id: true,
          name: true,
          runtimeKind: true,
          modelProvider: true,
          modelId: true,
          thinkingLevel: true,
          modelCredentialId: true,
          allowedModelDestinations: true,
        },
      }),
      prisma.space.findUnique({
        where: { id: spaceId },
        select: { allowedModelDestinations: true },
      }),
      prisma.run.findMany({
        where: {
          spaceId,
          userId,
          createdAt: { gte: since(INSIGHT_RUN_WINDOW_DAYS) },
          status: { in: ["completed", "failed"] },
        },
        select: {
          id: true,
          botId: true,
          trigger: true,
          boardItemId: true,
          status: true,
          error: true,
          runtimePin: true,
          runtimeDestination: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.spaceModelPreference.findMany({
        where: { spaceId, userId },
        select: { credential: { select: { id: true, provider: true, label: true } } },
      }),
      prisma.feedback.count({
        where: {
          spaceId,
          actorId: userId,
          retractedAt: null,
          reason: { not: null },
          NOT: { reason: "" },
          updatedAt: { gte: since(LEARNING_OFF_WINDOW_DAYS) },
        },
      }),
      prisma.externalEffect.findMany({
        where: {
          spaceId,
          decisionByUserId: userId,
          decision: { in: ["allow", "deny"] },
          decisionAt: { gte: since(APPROVAL_WINDOW_DAYS), lte: now },
          run: { spaceId, userId },
        },
        select: { kind: true, decision: true, decisionAt: true, run: { select: { botId: true } } },
      }),
      prisma.actionApprovalRule.findMany({
        where: { spaceId, createdByUserId: userId, effect: "always_allow", matchKind: "tool" },
        select: { botId: true, matchValue: true },
      }),
      prisma.task.findMany({
        where: {
          spaceId,
          userId,
          createdAt: { gte: since(ROUTINE_WINDOW_DAYS) },
          runs: { some: { trigger: "user", userId } },
        },
        select: { botId: true, prompt: true, createdAt: true },
      }),
      prisma.routine.findMany({
        where: { spaceId, userId },
        select: { botId: true, prompt: true },
      }),
    ]);
  const runIds = runs.map((run) => run.id);
  const failedIds = runs.filter((run) => run.status === "failed").map((run) => run.id);
  const tools = new Map<string, string[]>();
  const usage = new Map<string, { tokens: number; priced: boolean; cost: number | null }>();
  const failurePayloads = new Map<string, unknown>();
  for (const ids of chunks(runIds)) {
    const [toolRows, usageRows] = await Promise.all([
      prisma.$queryRaw<Array<{ runId: string; names: string[] }>>`
        SELECT "runId", array_agg(DISTINCT payload->>'name') AS names
        FROM events
        WHERE "spaceId" = ${spaceId} AND type = 'agent.tool.called'
          AND "runId" IN (${Prisma.join(ids)})
        GROUP BY "runId"`,
      prisma.$queryRaw<
        Array<{ runId: string; tokens: bigint | number; priced: boolean; cost: number | null }>
      >`
        SELECT "runId",
          SUM("inputTokens" + "outputTokens") AS tokens,
          BOOL_AND(cost IS NOT NULL AND "pricingProvenance" IS NOT NULL) AS priced,
          SUM(cost) AS cost
        FROM usage_records
        WHERE "spaceId" = ${spaceId} AND "userId" = ${userId}
          AND purpose <> 'detached-learning' AND "runId" IN (${Prisma.join(ids)})
        GROUP BY "runId"`,
    ]);
    for (const row of toolRows) tools.set(row.runId, row.names.filter(Boolean));
    for (const row of usageRows)
      usage.set(row.runId, {
        tokens: Number(row.tokens),
        priced: row.priced,
        cost: row.cost === null ? null : Number(row.cost),
      });
  }
  for (const ids of chunks(failedIds)) {
    const events = await prisma.event.findMany({
      where: { spaceId, runId: { in: ids }, type: "run.failed" },
      select: { runId: true, payload: true },
    });
    for (const event of events) if (event.runId) failurePayloads.set(event.runId, event.payload);
  }
  const thumbs = new Map<string, { up: boolean; down: boolean }>();
  for (const ids of chunks(runIds)) {
    const rows = await prisma.feedback.findMany({
      where: { spaceId, actorId: userId, retractedAt: null, runId: { in: ids } },
      select: { runId: true, rating: true },
    });
    for (const row of rows) {
      const value = thumbs.get(row.runId) ?? { up: false, down: false };
      if (row.rating === "positive") value.up = true;
      if (row.rating === "negative") value.down = true;
      thumbs.set(row.runId, value);
    }
  }

  const credentials = preferences.map((preference) => preference.credential);
  const connected = new Set(credentials.map((credential) => credential.id));
  const runFacts: InsightRunFact[] = runs.map((run) => {
    const spend = usage.get(run.id);
    const started = run.startedAt ?? run.createdAt;
    const ended = run.completedAt ?? run.updatedAt;
    return {
      id: run.id,
      botId: run.botId,
      trigger: run.trigger,
      board: !!run.boardItemId,
      status: run.status,
      at: ended,
      durationMs: run.completedAt ? Math.max(0, ended.getTime() - started.getTime()) : null,
      pin: pinOf(run.runtimePin),
      tools: tools.get(run.id) ?? [],
      tokens: spend ? spend.tokens : null,
      cost: spend?.priced && spend.cost !== null ? spend.cost : null,
      thumbsUp: !!thumbs.get(run.id)?.up,
      thumbsDown: !!thumbs.get(run.id)?.down,
      failure:
        run.status === "failed"
          ? insightFailureClass(run.error, failurePayloads.get(run.id))
          : null,
    };
  });

  // Where each model ran, from the destination recorded on its runs.
  const destinations = new Map<string, { host: string | null; local: boolean }>();
  const latest = new Map<string, InsightRunFact>();
  for (const [index, run] of runFacts.entries()) {
    const key = insightModelKey(run.pin);
    if (!key) continue;
    const destination = ModelDestinationSchema.safeParse(runs[index]!.runtimeDestination);
    if (destination.success) destinations.set(key, destination.data);
    const previous = latest.get(key);
    if (!previous || run.at > previous.at) latest.set(key, run);
  }
  const rejected = new Set(
    runFacts
      .filter((run) => run.failure === "credential" && run.pin?.credentialId)
      .filter((run) => {
        const worked = runFacts.some(
          (other) =>
            other.status === "completed" &&
            other.pin?.credentialId === run.pin!.credentialId &&
            other.at > run.at,
        );
        return !worked;
      })
      .map((run) => run.pin!.credentialId!),
  );
  const models: Record<string, InsightModelFact> = {};
  const pins = [
    ...runFacts.map((run) => run.pin),
    ...bots.map(
      (bot): InsightPin => ({
        runtimeKind: bot.runtimeKind,
        provider: bot.modelProvider,
        modelId: bot.modelId,
        effort: bot.thinkingLevel,
        credentialId: bot.modelCredentialId,
      }),
    ),
  ];
  for (const pin of pins) {
    const key = insightModelKey(pin);
    if (!key || !pin || models[key]) continue;
    const credentialOk =
      pin.runtimeKind !== "pi" ||
      !pin.credentialId ||
      (connected.has(pin.credentialId) && !rejected.has(pin.credentialId));
    models[key] = {
      label: modelLabel(pin),
      local: LOCAL_PROVIDERS.has(pin.provider ?? "") || !!destinations.get(key)?.local,
      // Can run now: its connection is still here and working, and its latest run finished.
      available: credentialOk && latest.get(key)?.status === "completed",
      ...(pin.runtimeKind === "pi" && pin.provider && pin.modelId
        ? (() => {
            const contextWindow = piModelContextWindow(pin.provider, pin.modelId);
            return contextWindow ? { contextWindow } : {};
          })()
        : {}),
    };
  }
  const spacePolicy = LocalityPolicySchema.safeParse(
    space?.allowedModelDestinations ?? { mode: "any" },
  );
  const allowedFor = (policyValue: unknown): string[] | null => {
    const policies = [spacePolicy, LocalityPolicySchema.safeParse(policyValue ?? { mode: "any" })];
    if (policies.every((policy) => policy.success && policy.data.mode === "any")) return null;
    return Object.keys(models).filter((key) => {
      const destination = destinations.get(key);
      return (
        !!destination &&
        policies.every(
          (policy) => policy.success && allowsModelDestination(policy.data, destination),
        )
      );
    });
  };

  let memory = { documents: 0, bytes: 0, semantic: true };
  if (options.owner) {
    const [counts, config] = await Promise.all([
      prisma.$queryRaw<Array<{ documents: number | bigint; bytes: number | bigint }>>`
        SELECT COUNT(*) AS documents, COALESCE(SUM(octet_length(content)), 0) AS bytes
        FROM memory_documents
        WHERE "spaceId" = ${spaceId} AND "userId" = ${userId} AND scope = 'user'
          AND "deletedAt" IS NULL AND path NOT LIKE 'preferences/%'`,
      prisma.spaceMemoryConfig.findUnique({ where: { spaceId }, select: { provider: true } }),
    ]);
    memory = {
      documents: Number(counts[0]?.documents ?? 0),
      bytes: Number(counts[0]?.bytes ?? 0),
      semantic: !!config && config.provider !== "builtin",
    };
  }
  const providerNames = Object.fromEntries(
    listPiCatalog().map((entry) => [entry.provider, entry.providerName]),
  );

  return {
    now,
    isOwner: options.owner,
    bots: bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      pin: {
        runtimeKind: bot.runtimeKind,
        provider: bot.modelProvider,
        modelId: bot.modelId,
        effort: bot.thinkingLevel,
        credentialId: bot.modelCredentialId,
      },
      allowed: allowedFor(bot.allowedModelDestinations),
    })),
    runs: runFacts,
    models,
    credentials,
    providerNames,
    memory,
    learningEnabled: options.learningEnabled,
    feedbackReasons,
    approvals: approvals.flatMap((approval) =>
      approval.decisionAt && (approval.decision === "allow" || approval.decision === "deny")
        ? [
            {
              botId: approval.run.botId,
              tool: approval.kind,
              decision: approval.decision,
              at: approval.decisionAt,
            },
          ]
        : [],
    ),
    allowRules: allowRules.map((rule) => ({ botId: rule.botId, tool: rule.matchValue })),
    prompts: tasks.map((task) => ({
      botId: task.botId,
      text: redactLearningText(task.prompt),
      at: task.createdAt,
    })),
    routines,
  };
}

/** Recompute one person's insights. Dismissals win over a concurrent pass. */
export async function refreshLearningInsights(
  prisma: PrismaClient,
  identity: Identity,
  now = new Date(),
): Promise<void> {
  const [member, config] = await Promise.all([
    prisma.spaceMember.findUnique({
      where: { spaceId_userId: identity },
      select: { role: true },
    }),
    prisma.spaceLearningConfig.findUnique({
      where: { spaceId: identity.spaceId },
      select: { enabled: true, insightsEnabled: true },
    }),
  ]);
  const computed =
    member && (config?.insightsEnabled ?? true)
      ? computeInsights(
          await loadInsightFacts(
            prisma,
            identity,
            { owner: isOwner(member.role), learningEnabled: !!config?.enabled },
            now,
          ),
        )
      : [];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`learning-insights:${identity.spaceId}:${identity.userId}`}, 0))`;
    const stored = await tx.learningInsight.findMany({
      where: identity,
      select: { id: true, fingerprint: true, status: true, evidence: true, expiresAt: true },
    });
    const rows = stored.flatMap((row) => {
      const evidence = InsightEvidenceSchema.safeParse(row.evidence);
      const status = row.status as "active" | "dismissed" | "acted" | "expired";
      return evidence.success ? [{ ...row, status, evidence: evidence.data }] : [];
    });
    for (const change of reconcileInsights(rows, computed, now)) {
      if (change.op === "expire") {
        await tx.learningInsight.updateMany({
          where: { id: change.id, status: "active" },
          data: { status: "expired" },
        });
        continue;
      }
      const data = {
        kind: change.insight.kind,
        botId: change.insight.botId,
        evidence: change.insight.evidence as Prisma.InputJsonValue,
        action: change.insight.action as Prisma.InputJsonValue,
        expiresAt: change.expiresAt,
      };
      if (change.op === "create")
        await tx.learningInsight.create({
          data: { ...identity, fingerprint: change.insight.fingerprint, ...data },
        });
      else if (change.op === "refresh")
        await tx.learningInsight.updateMany({ where: { id: change.id, status: "active" }, data });
      else {
        const previous = rows.find((row) => row.id === change.id)!;
        await tx.learningInsight.updateMany({
          where: { id: change.id, status: previous.status },
          data: { ...data, status: "active", createdAt: now },
        });
      }
    }
  });
}

/** One person, every member of one space, or (daily) every member of every space. */
export async function learningInsightsJob(
  prisma: PrismaClient,
  payload: { spaceId?: string; userId?: string },
  now = new Date(),
): Promise<void> {
  if (payload.spaceId && payload.userId) {
    await refreshLearningInsights(
      prisma,
      { spaceId: payload.spaceId, userId: payload.userId },
      now,
    );
    return;
  }
  let cursor: { spaceId: string; userId: string } | undefined;
  for (;;) {
    const members = await prisma.spaceMember.findMany({
      where: {
        ...(payload.spaceId ? { spaceId: payload.spaceId } : {}),
        space: { deletingAt: null },
      },
      select: { spaceId: true, userId: true },
      orderBy: [{ spaceId: "asc" }, { userId: "asc" }],
      take: 200,
      ...(cursor ? { cursor: { spaceId_userId: cursor }, skip: 1 } : {}),
    });
    for (const member of members)
      await refreshLearningInsights(prisma, member, now).catch((error) =>
        getLogger().error("learning.insights refresh error", error),
      );
    if (members.length < 200) return;
    cursor = members.at(-1);
  }
}

/** Debounced: the first trigger schedules a pass; triggers before it runs join that pass. */
export async function enqueueLearningInsights(deps: { jobs: JobPublisher }, identity: Identity) {
  await deps.jobs.enqueue({
    name: "learning.insights",
    payload: identity,
    replaceKey: `learning.insights:${identity.spaceId}:${identity.userId}`,
    preserveRunAt: true,
    availableAt: new Date(Date.now() + INSIGHTS_DEBOUNCE_MS),
  });
}

function insightView(row: {
  id: string;
  botId: string | null;
  status: string;
  evidence: unknown;
  action: unknown;
  createdAt: Date;
  expiresAt: Date;
}): (LearningInsight & { impact: number }) | null {
  const evidence = InsightEvidenceSchema.safeParse(row.evidence);
  const action = InsightActionSchema.safeParse(row.action);
  if (!evidence.success || !action.success) return null;
  return {
    id: row.id,
    botId: row.botId,
    status: row.status as LearningInsight["status"],
    evidence: evidence.data,
    action: action.data,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    impact: insightImpact(evidence.data),
  };
}

/**
 * The person's active insights, highest impact first. Another member's rows are never read;
 * space setup insights need the owner role now, not only when they were computed.
 */
export async function listLearningInsights(
  prisma: PrismaClient,
  identity: Identity,
  botId?: string,
  now = new Date(),
): Promise<LearningInsight[]> {
  const [member, config] = await Promise.all([
    prisma.spaceMember.findUnique({ where: { spaceId_userId: identity }, select: { role: true } }),
    prisma.spaceLearningConfig.findUnique({
      where: { spaceId: identity.spaceId },
      select: { insightsEnabled: true },
    }),
  ]);
  if (!member) throw new IsolationError();
  if (config && !config.insightsEnabled) return [];
  const rows = await prisma.learningInsight.findMany({
    where: {
      ...identity,
      status: "active",
      expiresAt: { gt: now },
      ...(botId ? { botId } : {}),
      ...(isOwner(member.role) ? {} : { kind: { notIn: [...SPACE_INSIGHT_KINDS] } }),
    },
  });
  const liveBots = new Set(
    (
      await prisma.bot.findMany({
        where: { ...identity, archivedAt: null },
        select: { id: true },
      })
    ).map((bot) => bot.id),
  );
  return rows
    .filter((row) => !row.botId || liveBots.has(row.botId))
    .flatMap((row) => {
      const view = insightView(row);
      return view ? [view] : [];
    })
    .sort((x, y) => y.impact - x.impact || y.createdAt.localeCompare(x.createdAt))
    .slice(0, MAX_ACTIVE_INSIGHTS)
    .map(({ impact: _impact, ...insight }) => insight);
}

/** Dismiss hides it until the evidence changes materially; acted records that its action was used. */
export async function settleLearningInsight(
  prisma: PrismaClient,
  identity: Identity,
  insightId: string,
  status: "dismissed" | "acted",
  now = new Date(),
): Promise<void> {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: identity },
    select: { role: true },
  });
  if (!member) throw new IsolationError();
  const updated = await prisma.learningInsight.updateMany({
    where: {
      id: insightId,
      ...identity,
      status: { in: ["active", "dismissed", "acted"] },
      ...(isOwner(member.role) ? {} : { kind: { notIn: [...SPACE_INSIGHT_KINDS] } }),
    },
    data: { status, expiresAt: new Date(now.getTime() + INSIGHT_SUPPRESSION_DAYS * DAY_MS) },
  });
  if (updated.count !== 1) throw new IsolationError();
}
