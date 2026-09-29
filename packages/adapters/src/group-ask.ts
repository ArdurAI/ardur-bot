import { runContinueJob } from "@ardurbot/adapter-kit";
import { GOAL_DEFAULT_PER_WORKER_TOKENS, type MessageBlock } from "@ardurbot/contracts";
import {
  ASK_REQUEST_MAX_LENGTH,
  askMemberPrompt,
  askRoundForRun,
  groupAskKey,
  groupAskMessageNonce,
  groupAskPrefix,
  MAX_ASK_ROUNDS,
  parseAskWakeNonce,
  redactTaskValue,
  renderAskResults,
  selectAskTargets,
} from "@ardurbot/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  DelegationAdmissionError,
  IsolationError,
  loadGroupAskResults,
  lockOwnedGroup,
  peerTrafficPaused,
  recordGroupAskUpdateInTransaction,
  sizeDelegationRootForAsk,
  touchGroupUpdatedAt,
  wakeCoordinatorForGroupAsk,
  withTransactionRetry,
} from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import type { DelegationResolver } from "./delegation.js";
import { prepareDelegation } from "./delegation.js";
import type { ExecutorDeps } from "./executor.js";

/** One member's answer is at most one ordinary worker turn, like a goal assignment. */
export const ASK_MEMBER_TOKENS = GOAL_DEFAULT_PER_WORKER_TOKENS;

type AskRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  clientNonce?: string | null;
};

type NotAsked = { member: string; reason: string };
type Asked = { botId: string; name: string };

export type AskMembersResult =
  | { error: string; notAsked?: NotAsked[] }
  | { ok: true; asked: Asked[]; notAsked: NotAsked[]; note: string; replayed?: true };

type Committed =
  | { error: string; notAsked?: NotAsked[] }
  | { asked: Asked[]; notAsked: NotAsked[]; runIds: string[]; eventSeq?: number; replayed?: true };

const names = (members: readonly { name: string }[]) => {
  const list = members.map((member) => member.name);
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : (list[0] ?? "");
};

const askedNote = (asked: readonly { name: string }[]) =>
  `Asked ${names(asked)}. They answer here after this turn ends, and their answers come back to you then. End this turn now without a reply; the room already shows your request.`;

/**
 * Start one turn for each asked member, in this room, with the coordinator's request. Each
 * member is a budgeted delegation audited like a handoff; the coordinator keeps the floor
 * until its turn ends, then gets every answer or failure back on one follow-up turn.
 */
export async function askGroupMembers(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs"> & {
    resolveDelegationPin?: DelegationResolver;
  },
  run: AskRun,
  groupId: string,
  input: { members: unknown; request: unknown; callId: string },
): Promise<AskMembersResult> {
  const requested = Array.isArray(input.members)
    ? input.members.filter((value): value is string => typeof value === "string").slice(0, 12)
    : [];
  const request = redactTaskValue(String(input.request ?? "").trim());
  if (!requested.length) return { error: 'members is required: ids, exact names, or ["all"]' };
  if (!request) return { error: "request is required" };
  if (request.length > ASK_REQUEST_MAX_LENGTH)
    return { error: `request exceeds the ${ASK_REQUEST_MAX_LENGTH} character limit` };
  const round = askRoundForRun(run.clientNonce);
  if (round > MAX_ASK_ROUNDS)
    return {
      error:
        "You already asked the room about this request. Answer the user with what you have, and say what is still missing.",
    };
  const ask = { round, askRunId: run.id };
  const messageNonce = groupAskMessageNonce(ask, input.callId);
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx): Promise<Committed> => {
      try {
        await lockOwnedGroup(tx, run, groupId);
      } catch (error) {
        if (error instanceof IsolationError) return { error: "group is no longer available" };
        throw error;
      }
      const [group, source] = await Promise.all([
        tx.chatGroup.findFirst({
          where: { id: groupId, archivedAt: null, thread: { id: run.threadId } },
          include: {
            members: {
              where: { bot: { archivedAt: null } },
              include: { bot: { select: { id: true, name: true } } },
              orderBy: { createdAt: "asc" },
            },
          },
        }),
        tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            status: "running",
          },
          select: { id: true },
        }),
      ]);
      if (!group || !source) return { error: "source run is no longer active" };
      if (group.coordinatorBotId !== run.botId)
        return { error: "ask_members is only for this group's coordinator" };
      if (await peerTrafficPaused(tx, { spaceId: run.spaceId, userId: run.userId, groupId }))
        return {
          error: "Team messages are paused in this room. Tell the user what you would ask.",
        };
      const members = group.members.map((member) => member.bot);
      const coordinator = members.find((member) => member.id === run.botId);
      if (!coordinator) return { error: "source bot is no longer a group member" };

      const existing = await tx.message.findUnique({
        where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: messageNonce } },
        select: { id: true },
      });
      if (existing) {
        const recorded = await tx.delegation.findMany({
          where: {
            parentRunId: run.id,
            admissionKey: { startsWith: `${messageNonce}:` },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { actingBotId: true, actingName: true },
        });
        return {
          replayed: true,
          asked: recorded.map((row) => ({ botId: row.actingBotId, name: row.actingName })),
          notAsked: [],
          runIds: [],
        };
      }

      const { targets, unknown } = selectAskTargets(members, requested, run.botId);
      const notAsked: NotAsked[] = unknown.map((member) => ({
        member,
        reason: "not a current member of this room",
      }));
      // Asking again in the same turn never starts a second turn for the same member.
      const already = new Set(
        (
          await tx.delegation.findMany({
            where: { parentRunId: run.id, admissionKey: { startsWith: groupAskPrefix(ask) } },
            select: { actingBotId: true },
          })
        ).map((row) => row.actingBotId),
      );
      for (const target of targets.filter((member) => already.has(member.id)))
        notAsked.push({ member: target.name, reason: "already asked in this turn" });
      const fresh = targets.filter((member) => !already.has(member.id));
      if (!fresh.length)
        return {
          error: members.some((member) => member.id !== run.botId)
            ? "No member to ask. Use member ids or exact names from the room member list."
            : "This room has no other members to ask.",
          notAsked,
        };

      await sizeDelegationRootForAsk(tx, {
        runId: run.id,
        members: fresh.length,
        tokensPerMember: ASK_MEMBER_TOKENS,
      });
      const admitted: Array<{
        member: { id: string; name: string };
        admission: Extract<Awaited<ReturnType<typeof prepareDelegation>>, { ok: true }>;
      }> = [];
      for (const member of fresh) {
        try {
          const admission = await prepareDelegation(
            tx,
            {
              spaceId: run.spaceId,
              userId: run.userId,
              parentRunId: run.id,
              actingBotId: member.id,
              actingName: member.name,
              kind: "group-handoff",
              admissionKey: groupAskKey(ask, input.callId, member.id),
              prompt: request,
              tokens: ASK_MEMBER_TOKENS,
              targetThreadId: run.threadId,
            },
            deps.resolveDelegationPin,
          );
          if (admission.ok) admitted.push({ member, admission });
          else notAsked.push({ member: member.name, reason: admission.error });
        } catch (error) {
          if (!(error instanceof DelegationAdmissionError)) throw error;
          notAsked.push({ member: member.name, reason: error.problem.message });
        }
      }
      if (!admitted.length) return { error: "No member could be asked.", notAsked };

      const blocks: MessageBlock[] = [
        {
          kind: "coordination",
          nonce: messageNonce,
          round,
          text: request,
          updates: [],
          members: admitted.map(({ member }) => ({
            botId: member.id,
            name: member.name,
            outcome: "pending" as const,
          })),
        },
      ];
      const message = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        role: "bot",
        blocks,
        botId: run.botId,
        runId: run.id,
        clientNonce: messageNonce,
        markUnread: false,
      });
      const created = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        type: "thread.message.created",
        runId: run.id,
        payload: { messageId: message.id, role: "bot", blocks },
      });
      const prompt = askMemberPrompt({ from: coordinator, request });
      const runIds: string[] = [];
      let eventSeq = created.seq;
      for (const { member, admission } of admitted) {
        const task = await tx.task.create({
          data: {
            spaceId: run.spaceId,
            botId: member.id,
            threadId: run.threadId,
            userId: run.userId,
            prompt,
            status: "queued",
          },
        });
        const memberRun = await tx.run.create({
          data: {
            ...admission.runData,
            spaceId: run.spaceId,
            botId: member.id,
            threadId: run.threadId,
            taskId: task.id,
            userId: run.userId,
            status: "queued",
            trigger: "follow_up",
            sourceMessageId: message.id,
          },
        });
        await tx.delegation.update({
          where: { id: admission.record.id },
          data: { runId: memberRun.id },
        });
        // Audited like a handoff: the same event names who asked whom, and for what.
        const event = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "group.handoff",
          runId: run.id,
          payload: {
            messageId: message.id,
            fromBotId: run.botId,
            toBotId: member.id,
            text: request,
            mode: "ask",
            delegationId: admission.record.id,
          },
        });
        eventSeq = event.seq;
        runIds.push(memberRun.id);
      }
      await touchGroupUpdatedAt(tx, groupId);
      return {
        asked: admitted.map(({ member }) => ({ botId: member.id, name: member.name })),
        notAsked,
        runIds,
        eventSeq,
      };
    }),
  );
  if ("error" in committed)
    return committed.notAsked?.length
      ? { error: committed.error, notAsked: committed.notAsked }
      : { error: committed.error };
  if (committed.eventSeq !== undefined)
    await deps.events.notify(run.threadId, committed.eventSeq).catch((error) => {
      getLogger().error("group ask realtime notification", error);
    });
  for (const runId of committed.runIds)
    await deps.jobs.enqueue(runContinueJob(runId)).catch((error) => {
      // The queued run is durable and the job reconciler will repair a missed immediate wake.
      getLogger().error("group ask enqueue", error);
    });
  return {
    ok: true,
    asked: committed.asked,
    notAsked: committed.notAsked,
    note: askedNote(committed.asked),
    ...(committed.replayed ? { replayed: true as const } : {}),
  };
}

/**
 * Fold one coordinator progress note into its open coordination round instead
 * of a chat bubble: mid-round narration shows on the round's collapsed line.
 * Returns false when the round's message is gone, so the caller posts normally.
 */
export async function recordGroupAskProgress(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  run: AskRun,
  input: { nonce: string; note: string },
): Promise<boolean> {
  const recorded = await deps.prisma.$transaction((tx) =>
    recordGroupAskUpdateInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      nonce: input.nonce,
      note: input.note,
    }),
  );
  if (!recorded) return false;
  await deps.events.notify(recorded.threadId, recorded.seq).catch((error) => {
    getLogger().error("group ask progress notification", error);
  });
  return true;
}

/** After an asked member's run settles, queue the coordinator's follow-up if it was the last. */
export async function wakeCoordinatorAfterAsk(
  deps: Pick<ExecutorDeps, "prisma" | "jobs">,
  delegationId: string | null | undefined,
) {
  if (!delegationId) return;
  const wake = await wakeCoordinatorForGroupAsk(deps.prisma, delegationId);
  if (wake)
    await deps.jobs.enqueue(runContinueJob(wake.runId)).catch((error) => {
      // The queued run is durable and the job reconciler also scans queued runs.
      getLogger().error("group ask wake enqueue", error);
    });
}

/** The asked members' results, as required task data on the coordinator's follow-up turn. */
export async function loadAskWakeContext(
  prisma: ExecutorDeps["prisma"],
  run: { spaceId: string; userId: string; clientNonce?: string | null },
): Promise<string | undefined> {
  const ask = parseAskWakeNonce(run.clientNonce);
  if (!ask) return undefined;
  const loaded = await loadGroupAskResults(
    prisma,
    { spaceId: run.spaceId, userId: run.userId },
    ask,
  );
  return loaded.results.length ? renderAskResults(loaded.results, loaded.userRequest) : undefined;
}
