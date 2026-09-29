import { deploymentHostLabel } from "@ardurbot/adapters";
import type { Actor, HostLabel, TeamRow } from "@ardurbot/contracts";
import {
  DelegationSnapshotSchema,
  FailureCategoryIdSchema,
  failureCategoryFromText,
  RunFailurePayloadSchema,
  RuntimeInfoSchema,
  runtimeNames,
  taskCardSentence,
} from "@ardurbot/contracts";
import { ENGINE_LABELS } from "@ardurbot/contracts/fleet";
import { redactTaskValue } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { acceptDelegation, delegationView, loadBotPresence } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";

async function requireMember(prisma: PrismaClient, actor: Actor) {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
  });
  if (!member) throw new ORPCError("FORBIDDEN");
}
const active = ["queued", "leased", "running", "waiting_input", "waiting_takeover"];
/**
 * Terminal handoff records are listed on the board only for a recent window; the board is
 * polled per client and a long-lived space accrues records without limit. Active records
 * are never bounded, and an older terminal record still appears through latestCards when
 * it is the bot's latest work.
 */
const TEAM_BOARD_TERMINAL_CARD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export function teamState(input: {
  runStatus?: string;
  delegationStatus?: string;
  approval: boolean;
  blocked?: boolean;
}): TeamRow["state"] {
  if (input.approval) return "waiting-approval";
  if (input.blocked) return "blocked";
  if (input.delegationStatus === "completed") return "completed";
  if (input.delegationStatus === "accepted" && !active.includes(input.runStatus ?? ""))
    return "accepted";
  if (
    ["waiting_input", "waiting_takeover", "failed"].includes(input.runStatus ?? "") ||
    ["failed", "cancel-requested"].includes(input.delegationStatus ?? "")
  )
    return "blocked";
  if (input.runStatus === "running" || input.delegationStatus === "running") return "working";
  if (["queued", "leased"].includes(input.runStatus ?? "") || input.delegationStatus === "queued")
    return "queued";
  return "idle";
}

/** A computer without a saved connection is named by the engine of its kind. */
function engineName(
  kind: string,
  host: HostLabel,
): { name: string | null; builtin?: "host" | "local-docker" } {
  if (kind === "desktop") return { name: host, builtin: "host" };
  if (kind === "docker")
    return {
      name: host === "This Mac" ? "Docker on this Mac" : "Docker on this computer",
      builtin: "local-docker",
    };
  return { name: ENGINE_LABELS[kind] ?? null };
}

/** No messages, prompt text or current model settings participate in this projection. */
export async function teamBoard(
  prisma: PrismaClient,
  actor: Actor,
): Promise<{ rows: TeamRow[]; hostLabel: HostLabel }> {
  await requireMember(prisma, actor);
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const [bots, activeRuns, latestRuns, openCards, latestCards, directory, policies] =
    await Promise.all([
      prisma.bot.findMany({
        where: { ...scope, archivedAt: null },
        include: { thread: true, computer: true },
        orderBy: { name: "asc" },
      }),
      prisma.run.findMany({
        where: { ...scope, status: { in: active } },
        include: { thread: { select: { groupId: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.run.findMany({
        where: scope,
        distinct: ["botId"],
        include: { thread: { select: { groupId: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.delegation.findMany({
        // Terminal records stay listed after the run ends; a failed or cancelled handoff
        // must not vanish from the board while it is still that bot's latest work. Active
        // records are always listed; terminal ones are bounded to a recent window.
        where: {
          ...scope,
          OR: [
            { status: { in: ["queued", "running", "cancel-requested"] } },
            {
              status: { in: ["completed", "failed", "cancelled"] },
              createdAt: { gte: new Date(Date.now() - TEAM_BOARD_TERMINAL_CARD_WINDOW_MS) },
            },
          ],
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.delegation.findMany({
        where: scope,
        distinct: ["actingBotId"],
        orderBy: { createdAt: "desc" },
      }),
      loadBotPresence(prisma, scope),
      prisma.botCommunicationPolicy.findMany({
        where: { ...scope, OR: [{ paused: true }, { enabled: false }] },
        select: { scopeKey: true },
      }),
    ]);
  const pausedScopes = new Set(policies.map((policy) => policy.scopeKey));
  const presenceByBot = new Map(directory.bots.map((item) => [item.botId, item]));
  const runs = [...new Map([...activeRuns, ...latestRuns].map((run) => [run.id, run])).values()];
  const delegations = [
    ...new Map([...openCards, ...latestCards].map((row) => [row.id, row])).values(),
  ];
  const runIds = runs.map((run) => run.id);
  const rootIds = [
    ...new Set([
      ...runs.map((run) => run.delegationRootTaskId ?? run.taskId),
      ...delegations.map((row) => row.rootTaskId),
    ]),
  ];
  const [approvals, usage, roots, failures] = await Promise.all([
    prisma.externalEffect.findMany({
      where: { spaceId: actor.spaceId, runId: { in: runIds }, status: "intended" },
      select: { runId: true },
    }),
    prisma.usageRecord.findMany({
      where: {
        ...scope,
        OR: [{ runId: { in: runIds } }, { delegationId: { in: delegations.map((row) => row.id) } }],
      },
    }),
    prisma.delegationRoot.findMany({ where: { ...scope, rootTaskId: { in: rootIds } } }),
    prisma.event.findMany({
      where: { spaceId: actor.spaceId, runId: { in: runIds }, type: "run.failed" },
      distinct: ["runId"],
      orderBy: { createdAt: "desc" },
      select: { runId: true, payload: true },
    }),
  ]);
  const connectionIds = [
    ...new Set(
      bots.flatMap((bot) => (bot.computer?.connectionId ? [bot.computer.connectionId] : [])),
    ),
  ];
  const computers = connectionIds.length
    ? await prisma.connection.findMany({
        where: { ...scope, id: { in: connectionIds }, connectorId: "computer" },
        select: { id: true, displayName: true },
      })
    : [];
  const host = bots.some((bot) => bot.computer && !bot.computer.connectionId)
    ? await deploymentHostLabel(prisma)
    : "This computer";
  const rows = bots.map((bot): TeamRow => {
    const presence = presenceByBot.get(bot.id);
    const ownRuns = runs.filter((run) => run.botId === bot.id);
    const run = ownRuns.find((run) => active.includes(run.status)) ?? ownRuns[0];
    const own = delegations.filter((row) => row.actingBotId === bot.id);
    const delegation =
      own.find((row) => ["queued", "running", "cancel-requested"].includes(row.status)) ??
      own.find((row) => row.status === "completed") ??
      own[0];
    // A newer run displaces a handoff card. For a finished failed or cancelled handoff
    // any newer run of that bot displaces it, not only an active one: the card must not
    // resurface as "Blocked" forever after the bot has already moved on.
    const displaced = Boolean(
      delegation &&
        run &&
        run.delegationId !== delegation.id &&
        !(delegation.kind === "helper" && delegation.parentRunId === run.id) &&
        (active.includes(run.status) ||
          (["failed", "cancelled"].includes(delegation.status) &&
            run.createdAt.getTime() >= delegation.createdAt.getTime())),
    );
    const selected = delegation && !displaced ? delegation : undefined;
    const record = selected ? delegationView(selected) : undefined;
    const card = record?.card;
    const rootTaskId = selected?.rootTaskId ?? run?.delegationRootTaskId ?? run?.taskId ?? null;
    const root = roots.find((root) => root.rootTaskId === rootTaskId);
    const timelineState = card?.timeline.findLast((event) =>
      ["blocked", "progress", "started", "completed", "accepted"].includes(event.kind),
    );
    const approval = Boolean(
      run?.status === "waiting_input" && approvals.some((effect) => effect.runId === run.id),
    );
    const failure = RunFailurePayloadSchema.safeParse(
      failures.find((event) => event.runId === run?.id)?.payload,
    );
    const runtimeProblem = failure.success ? failure.data.runtimeProblem : undefined;
    // A finished failed or cancelled handoff carries its own recorded reason (already
    // redacted); a run that ended cancelled leaves no run.failed event to read one from.
    const recordedReason =
      selected && ["failed", "cancelled"].includes(selected.status)
        ? selected.result?.trim()
        : undefined;
    const problemCategory = FailureCategoryIdSchema.safeParse(runtimeProblem?.reasonId);
    const legacyCategory = recordedReason
      ? failureCategoryFromText(recordedReason)
      : undefined;
    const state = teamState({
      runStatus: run?.status,
      delegationStatus: selected?.status,
      approval,
      blocked:
        (selected?.status === "running" && timelineState?.kind === "blocked") ||
        ["error", "failed"].includes(bot.computer?.state ?? ""),
    });
    const reasonCategory =
      state === "blocked"
        ? problemCategory.success
          ? {
              category: problemCategory.data,
              runtime: runtimeProblem
                ? (runtimeNames[runtimeProblem.pin.runtimeKind] ?? null)
                : null,
            }
          : legacyCategory
            ? { category: legacyCategory.id, runtime: legacyCategory.params.runtime ?? null }
            : undefined
        : undefined;
    const executing = run?.startedAt
      ? DelegationSnapshotSchema.safeParse({
          pin: run.runtimePin,
          computer: run.runtimeComputer,
          destination: run.runtimeDestination,
        })
      : undefined;
    const spent = usage.filter((item) =>
      selected ? item.delegationId === selected.id : item.runId === run?.id,
    );
    const coordinatorName = bots.find((bot) => bot.id === root?.coordinatorBotId)?.name;
    const engine =
      bot.computer && !bot.computer.connectionId ? engineName(bot.computer.kind, host) : null;
    return {
      botId: bot.id,
      botName: bot.name,
      botColor: bot.color,
      availability: presence?.availability ?? "unknown",
      observedAt: presence?.observedAt ?? directory.observedAt,
      lastActiveAt: presence?.lastActiveAt,
      currentTaskTitle: presence?.currentTaskTitle,
      activeRunCount: presence?.activeRunCount ?? 0,
      activeRunIds: presence?.activeRunIds ?? [],
      pendingPeerCount: presence?.pendingPeerCount ?? 0,
      waitingForBotId: presence?.waitingForBotId,
      latestDeliveryId: presence?.latestDeliveryId,
      latestDeliveryState: presence?.latestDeliveryState,
      latestDeliveryGroupId: presence?.latestDeliveryGroupId,
      latestPeerBotId: presence?.latestPeerBotId,
      latestPeerBotName: bots.find((peer) => peer.id === presence?.latestPeerBotId)?.name,
      latestPeerBotColor: bots.find((peer) => peer.id === presence?.latestPeerBotId)?.color,
      goalId: presence?.goalId,
      reviewState: presence?.reviewState,
      trafficPaused:
        pausedScopes.has("space") ||
        Boolean(
          (presence?.latestDeliveryGroupId ?? run?.thread?.groupId) &&
            pausedScopes.has(`group:${presence?.latestDeliveryGroupId ?? run?.thread?.groupId}`),
        ),
      computerName: bot.computer?.connectionId
        ? (computers.find((connection) => connection.id === bot.computer?.connectionId)
            ?.displayName ?? null)
        : (engine?.name ?? null),
      computerBuiltin: engine?.builtin ?? null,
      threadId: bot.thread?.id ?? null,
      groupId: run?.thread?.groupId ?? null,
      cursor: (bot.thread?.nextEventSeq ?? 0) - 1,
      state,
      sentence: card ? taskCardSentence(card, selected!.actingName) : null,
      requesterName: selected?.requesterName ?? null,
      reason:
        state === "blocked"
          ? selected?.status === "cancel-requested"
            ? "Stopping"
            : timelineState?.kind === "blocked"
              ? timelineState.text
              : runtimeProblem
                ? redactTaskValue(runtimeProblem.reason)
                : recordedReason
                  ? redactTaskValue(recordedReason)
                  : run?.status === "failed"
                    ? "The run failed"
                    : "The task needs attention"
          : null,
      ...(reasonCategory
        ? { reasonCategory: reasonCategory.category, reasonRuntime: reasonCategory.runtime }
        : {}),
      action:
        state === "blocked"
          ? (timelineState?.action ?? "Open conversation")
          : approval
            ? "Review approval"
            : null,
      rootTaskId,
      delegationId: selected?.id ?? null,
      canStop: Boolean(
        root &&
          !root.cancelRequestedAt &&
          (root.activeDescendants > 0 || (run && active.includes(run.status))),
      ),
      canAccept: selected?.status === "completed",
      chain: selected
        ? [
            { id: selected.requesterBotId, name: selected.requesterName, role: "requester" },
            { id: selected.actingBotId, name: selected.actingName, role: "worker" },
            ...(root
              ? [
                  {
                    id: root.coordinatorBotId,
                    name: coordinatorName ?? selected.requesterName,
                    role: "reviewer" as const,
                  },
                ]
              : []),
          ]
        : [],
      delegations: rootTaskId
        ? delegations.filter((row) => row.rootTaskId === rootTaskId).map(delegationView)
        : [],
      executing: executing?.success
        ? {
            ...executing.data,
            runtimeInfo: RuntimeInfoSchema.safeParse(run?.runtimeInfo).data ?? null,
          }
        : selected?.kind === "helper" && selected.status !== "queued"
          ? record!.snapshot
          : null,
      usage: (() => {
        // Unavailable measurements stay unavailable. Unknown categories are omitted.
        // Partial categories are a lower bound, so the number is shown as "at least".
        // A zero fallback would claim a native run consumed nothing when usage never arrived.
        // A run that started (or finished) without any usage record is likewise unavailable;
        // zero is only honest for work that never started.
        const started = selected ? selected.status !== "queued" : Boolean(run?.startedAt);
        type Coverage = Record<string, string> | null;
        let measured = 0;
        let hasGap = false;
        for (const item of spent) {
          const coverage = (item.categoryCoverage as Coverage) ?? null;
          const inputState = coverage?.logicalInput;
          const outputState = coverage?.output;
          const inputUnknown = inputState === "unknown";
          const outputUnknown = outputState === "unknown";
          if (!inputUnknown) measured += item.inputTokens;
          if (!outputUnknown) measured += item.outputTokens;
          if (
            inputUnknown ||
            outputUnknown ||
            inputState === "partial" ||
            outputState === "partial"
          )
            hasGap = true;
        }
        return {
          tokens:
            spent.length === 0 ? (started ? null : 0) : measured === 0 && hasGap ? null : measured,
          partial: hasGap && measured > 0,
          costs: spent.flatMap((item) =>
            item.cost !== null && item.pricingProvenance
              ? [
                  {
                    amount: item.cost,
                    provenance: redactTaskValue(JSON.stringify(item.pricingProvenance)),
                  },
                ]
              : [],
          ),
        };
      })(),
    };
  });
  return { rows, hostLabel: host };
}
export async function acceptTeamTask(prisma: PrismaClient, actor: Actor, id: string) {
  await requireMember(prisma, actor);
  const row = await prisma.delegation.findFirstOrThrow({
    where: { id, spaceId: actor.spaceId, userId: actor.userId },
  });
  const root = await prisma.delegationRoot.findFirstOrThrow({
    where: { rootTaskId: row.rootTaskId, spaceId: actor.spaceId, userId: actor.userId },
  });
  return prisma.$transaction((tx) => acceptDelegation(tx, actor, id, root.coordinatorBotId));
}
