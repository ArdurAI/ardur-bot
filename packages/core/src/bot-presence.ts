import type { BotAvailability, BotPresence } from "@ardurbot/contracts";
import { TaskCardSchema } from "@ardurbot/contracts";
import { redactTaskValue } from "./task-card.js";

export const PRESENCE_STALE_MS = 60_000;
export const PRESENCE_AGED_MS = 30_000;
export const PRESENCE_ROLE_MAX = 160;
export const PRESENCE_TASK_MAX = 120;

export function presenceText(value: string | null | undefined, limit: number): string | undefined {
  const text = value
    ?.replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, limit) : undefined;
}

export function presenceFreshness(observedAt: string | undefined, now = Date.now()) {
  const age = observedAt ? now - Date.parse(observedAt) : Number.POSITIVE_INFINITY;
  return !Number.isFinite(age) || age >= PRESENCE_STALE_MS
    ? "unavailable"
    : age >= PRESENCE_AGED_MS
      ? "aged"
      : "fresh";
}

type Run = {
  id: string;
  status: string;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  goalId: string | null;
  delegationId: string | null;
  thread?: { groupId: string | null } | null;
};
type Card = {
  id: string;
  status: string;
  card: unknown;
  createdAt: Date;
  goalId?: string | null;
};

export function projectBotPresence(input: {
  bot: {
    id: string;
    name: string;
    title: string;
    description: string;
    concurrentRuns: number | null;
    thread?: { id: string } | null;
    computer?: {
      id: string;
      kind: string;
      state: string;
      controlHolder?: string;
      controlRunId?: string | null;
      controlLeaseExpiresAt?: Date | null;
    } | null;
  };
  groupIds: string[];
  runs: Run[];
  cards: Card[];
  goalTitle?: string;
  taskTitle?: string;
  activityAt?: Date;
  maintenanceActive?: boolean;
  pendingApprovalRunIds: ReadonlySet<string>;
  pendingPeerCount: number;
  latestDelivery?: { id: string; state: string; senderBotId: string; recipientBotId: string };
  computerDisplayName?: string;
  observedAt: Date;
  callerBotId?: string;
  canSend?: boolean;
  visibleGroupId?: string;
}): BotPresence {
  const { bot, observedAt } = input;
  const live = input.runs.filter(
    (run) =>
      ["leased", "running"].includes(run.status) &&
      run.leaseExpiresAt !== null &&
      run.leaseExpiresAt > observedAt,
  );
  const expired = input.runs.some(
    (run) =>
      ["leased", "running"].includes(run.status) &&
      (!run.leaseExpiresAt || run.leaseExpiresAt <= observedAt),
  );
  const waiting = input.runs.some(
    (run) =>
      (run.status === "waiting_input" && input.pendingApprovalRunIds.has(run.id)) ||
      (run.status === "waiting_takeover" &&
        bot.computer?.controlHolder === "user" &&
        bot.computer.controlRunId === run.id &&
        Boolean(
          bot.computer.controlLeaseExpiresAt && bot.computer.controlLeaseExpiresAt > observedAt,
        )),
  );
  const blocked = input.runs.some((run) =>
    ["waiting_input", "waiting_takeover"].includes(run.status),
  );
  const queued = input.runs.some((run) => run.status === "queued");
  const availability: BotAvailability = expired
    ? "unknown"
    : live.length || input.maintenanceActive
      ? "busy"
      : waiting
        ? "waiting-owner"
        : blocked
          ? "unavailable"
          : queued
            ? "queued"
            : ["failed", "error"].includes(bot.computer?.state ?? "")
              ? "unavailable"
              : "idle";
  const selectedRun = live[0] ?? input.runs.find((run) => run.status === "queued");
  const selectedCard = input.cards.find(
    (card) => card.id === selectedRun?.delegationId && ["running", "queued"].includes(card.status),
  );
  const parsedCard = selectedCard ? TaskCardSchema.safeParse(selectedCard.card) : null;
  // A room's directory may reveal that a bot is busy elsewhere, but not that room's task.
  const taskVisible =
    !input.visibleGroupId ||
    !selectedRun?.thread?.groupId ||
    selectedRun.thread.groupId === input.visibleGroupId;
  const latestAt = input.runs
    .flatMap((run) => [run.startedAt, run.completedAt])
    .concat(input.activityAt ?? [])
    .filter((date): date is Date => date instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const canMessage = Boolean(bot.thread && bot.id !== input.callerBotId && input.canSend !== false);
  return {
    botId: bot.id,
    name: bot.name,
    title: bot.title,
    roleSummary:
      presenceText(redactTaskValue(bot.title || bot.description), PRESENCE_ROLE_MAX) ?? "",
    groupIds: input.groupIds,
    ...(taskVisible && selectedRun?.goalId ? { goalId: selectedRun.goalId } : {}),
    availability,
    activeRunIds: live
      .filter(
        (run) =>
          !input.visibleGroupId ||
          !run.thread?.groupId ||
          run.thread.groupId === input.visibleGroupId,
      )
      .map((run) => run.id),
    activeRunCount: live.length,
    concurrentLimit: Math.max(1, bot.concurrentRuns ?? 1),
    ...(taskVisible
      ? {
          currentTaskTitle: presenceText(
            redactTaskValue(
              parsedCard?.success ? parsedCard.data.goal : (input.goalTitle ?? input.taskTitle),
            ),
            PRESENCE_TASK_MAX,
          ),
        }
      : {}),
    ...(taskVisible && selectedCard ? { delegationId: selectedCard.id } : {}),
    ...(latestAt ? { lastActiveAt: latestAt.toISOString() } : {}),
    observedAt: observedAt.toISOString(),
    staleAfter: new Date(observedAt.getTime() + PRESENCE_STALE_MS).toISOString(),
    computer: {
      ...(bot.computer?.id ? { id: bot.computer.id } : {}),
      ...(bot.computer?.kind ? { kind: bot.computer.kind } : {}),
      ...(input.computerDisplayName ? { displayName: input.computerDisplayName } : {}),
      ...(bot.computer ? { available: bot.computer.state === "running" } : {}),
    },
    canMessage,
    ...(!canMessage
      ? { cannotMessageReason: "This conversation is unavailable from the current task" }
      : {}),
    pendingPeerCount: input.pendingPeerCount,
    ...(!input.callerBotId && input.latestDelivery
      ? {
          latestDeliveryId: input.latestDelivery.id,
          latestDeliveryState: input.latestDelivery.state,
          latestPeerBotId:
            input.latestDelivery.senderBotId === bot.id
              ? input.latestDelivery.recipientBotId
              : input.latestDelivery.senderBotId,
        }
      : {}),
  };
}
