import type { Actor, TeamRow } from "@ardurbot/contracts";
import {
  DelegationSnapshotSchema,
  RunFailurePayloadSchema,
  taskCardSentence,
} from "@ardurbot/contracts";
import { redactTaskValue } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { acceptDelegation, delegationView } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";

async function requireMember(prisma: PrismaClient, actor: Actor) {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
  });
  if (!member) throw new ORPCError("FORBIDDEN");
}
const active = ["queued", "leased", "running", "waiting_input", "waiting_takeover"];
export function teamState(input: {
  runStatus?: string;
  delegationStatus?: string;
  approval: boolean;
  blocked?: boolean;
}): TeamRow["state"] {
  if (input.approval) return "waiting-approval";
  if (input.delegationStatus === "completed") return "completed";
  if (input.delegationStatus === "accepted" && !active.includes(input.runStatus ?? ""))
    return "accepted";
  if (
    input.blocked ||
    ["waiting_input", "waiting_takeover", "failed"].includes(input.runStatus ?? "") ||
    ["failed", "cancel-requested"].includes(input.delegationStatus ?? "")
  )
    return "blocked";
  if (input.runStatus === "running" || input.delegationStatus === "running") return "working";
  if (["queued", "leased"].includes(input.runStatus ?? "") || input.delegationStatus === "queued")
    return "queued";
  return "idle";
}

/** No messages, prompt text or current model settings participate in this projection. */
export async function teamBoard(prisma: PrismaClient, actor: Actor): Promise<{ rows: TeamRow[] }> {
  await requireMember(prisma, actor);
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const [bots, activeRuns, latestRuns, openCards, latestCards] = await Promise.all([
    prisma.bot.findMany({
      where: { ...scope, archivedAt: null },
      include: { thread: true },
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
      where: { ...scope, status: { in: ["queued", "running", "cancel-requested", "completed"] } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.delegation.findMany({
      where: scope,
      distinct: ["actingBotId"],
      orderBy: { createdAt: "desc" },
    }),
  ]);
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
  const rows = bots.map((bot): TeamRow => {
    const ownRuns = runs.filter((run) => run.botId === bot.id);
    const run = ownRuns.find((run) => active.includes(run.status)) ?? ownRuns[0];
    const own = delegations.filter((row) => row.actingBotId === bot.id);
    const delegation =
      own.find((row) => ["queued", "running", "cancel-requested"].includes(row.status)) ??
      own.find((row) => row.status === "completed") ??
      own[0];
    const selected =
      delegation &&
      (!run ||
        run.delegationId === delegation.id ||
        (delegation.kind === "helper" && delegation.parentRunId === run.id) ||
        !active.includes(run.status))
        ? delegation
        : undefined;
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
    const state = teamState({
      runStatus: run?.status,
      delegationStatus: selected?.status,
      approval,
      blocked: selected?.status === "running" && timelineState?.kind === "blocked",
    });
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
    return {
      botId: bot.id,
      botName: bot.name,
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
                : run?.status === "failed"
                  ? "The run failed"
                  : "The task needs attention"
          : null,
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
        ? executing.data
        : selected?.kind === "helper" && selected.status !== "queued"
          ? record!.snapshot
          : null,
      usage: {
        tokens: spent.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0),
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
      },
    };
  });
  return { rows };
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
