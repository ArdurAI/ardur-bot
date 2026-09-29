import type { CommandBlock, MessageBlock } from "@ardurbot/contracts";
import { isInterimNarrationAt, isToolActivityBlock } from "./tool-activity.js";

export type ActivityLabel =
  | "narration"
  | "reasoning"
  | "tool-activity"
  | "peer-delivery"
  | "delegation"
  | "unavailable";

export type ActivityOutcome = "pending" | "success" | "failure" | "unknown" | "interrupted";

export interface ActivityEvidence {
  label: ActivityLabel;
  /**
   * Display title. Absent when the core cannot name the block without
   * inventing copy — a historical shell event may have no command text, and
   * each frontend names that row in its own language instead.
   */
  title?: string;
  timestamp?: string;
  durationMs?: number;
  outcome?: ActivityOutcome;
}

export function mapMessageBlockToActivity(block: MessageBlock, live = false): ActivityEvidence {
  if (block.kind === "text") {
    return { label: "narration", title: block.text, outcome: "success" };
  }

  if (block.kind === "progress") {
    if (block.activity) {
      return {
        label: "tool-activity",
        title: block.text,
        outcome: live ? "pending" : "unknown",
      };
    }
    if (block.reasoning === true) {
      return { label: "reasoning", title: block.text, outcome: live ? "pending" : "success" };
    }
    // A plain progress block is assistant-authored narration.
    return { label: "narration", title: block.text, outcome: live ? "pending" : "success" };
  }

  if (block.kind === "steps") {
    const title = block.steps.map((s) => `${s.label} (${s.count})`).join(", ") || "Steps";
    return {
      label: "tool-activity",
      title,
      durationMs: block.durationMs,
      // Durable steps carry no durationMs; only a live message may report pending.
      outcome: block.durationMs !== undefined || !live ? "success" : "pending",
    };
  }

  if (block.kind === "command") {
    return {
      label: "tool-activity",
      title: block.command.command ?? undefined,
      timestamp: block.command.startedAt ?? undefined,
      durationMs: block.command.durationMs ?? undefined,
      outcome: mapCommandOutcome(block.command),
    };
  }

  if (block.kind === "handoff") {
    return { label: "delegation", title: block.text, outcome: "success" };
  }

  if (block.kind === "subagent") {
    return {
      label: "delegation",
      title: block.task,
      outcome:
        block.status === "completed"
          ? "success"
          : block.status === "failed"
            ? "failure"
            : "pending",
    };
  }

  if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
    return { label: "peer-delivery", title: "Peer message", outcome: "success" };
  }

  return { label: "unavailable", title: "Unavailable", outcome: "unknown" };
}

export interface WorkRecordEntry {
  block: MessageBlock;
  evidence: ActivityEvidence;
}

/**
 * Blocks that belong in the compact work record, in order: tool activity,
 * supplied reasoning summaries, and interim narration (notes that later tool
 * activity interrupts). Reply text and trailing narration stay in the bubble;
 * peer deliveries, delegations, and unavailable blocks render inline as their
 * own cards, so they stay out of the record too.
 */
export function workRecordEntries(
  blocks: readonly MessageBlock[],
  live = false,
): WorkRecordEntry[] {
  return blocks
    .map((block, index) => ({ block, evidence: mapMessageBlockToActivity(block, live), index }))
    .filter(
      (entry) =>
        entry.evidence.label === "tool-activity" ||
        entry.evidence.label === "reasoning" ||
        isInterimNarrationAt(blocks, entry.index),
    )
    .map(({ block, evidence }) => ({ block, evidence }));
}

function mapCommandOutcome(command: CommandBlock): ActivityOutcome {
  switch (command.outcome) {
    case "waiting":
    case "running":
      return "pending";
    case "completed":
      return command.exitCode === 0 ? "success" : "failure";
    case "cancelled":
      return "interrupted";
    case "unknown":
      return "unknown";
    default:
      return "unknown";
  }
}

export type WorkRecordStatus = "working" | "failed" | "interrupted" | "unknown" | "done";

export function workRecordStatus(entries: WorkRecordEntry[]): WorkRecordStatus {
  if (entries.some((m) => m.evidence.outcome === "pending")) return "working";
  if (entries.some((m) => m.evidence.outcome === "failure")) return "failed";
  if (entries.some((m) => m.evidence.outcome === "interrupted")) return "interrupted";
  if (entries.some((m) => m.evidence.outcome === "unknown")) return "unknown";
  return "done";
}

export function liveMessageHasVisibleActivity(message: {
  id: string;
  blocks: readonly MessageBlock[];
}): boolean {
  if (!message.id.startsWith("progress:")) return false;
  return (
    message.blocks.some(
      (block) => block.kind === "progress" && !isToolActivityBlock(block) && Boolean(block.text),
    ) || workRecordEntries(message.blocks).length > 0
  );
}

export function workingBotsWithoutVisibleActivity<Bot extends { botId?: string | null }>(
  workingBots: readonly Bot[],
  messages: readonly { id: string; blocks: readonly MessageBlock[]; botId?: string | null }[],
): Bot[] {
  const covered = new Set(
    messages.flatMap((message) =>
      message.botId && liveMessageHasVisibleActivity(message) ? [message.botId] : [],
    ),
  );
  return workingBots.filter((bot) => bot.botId == null || !covered.has(bot.botId));
}
