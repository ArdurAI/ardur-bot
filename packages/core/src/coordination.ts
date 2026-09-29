import type { MessageBlock } from "@ardurbot/contracts";

/** The coordination block, as stored by a coordinator's ask_members call. */
export type CoordinationBlock = Extract<MessageBlock, { kind: "coordination" }>;

export type CoordinationMember = CoordinationBlock["members"][number];

/** A member outcome as recorded in the coordination block. */
export type CoordinationOutcome = CoordinationMember["outcome"];

/** Find the coordination block of a message, if it carries one. */
export function coordinationBlock(blocks: readonly MessageBlock[]): CoordinationBlock | null {
  return blocks.find((block): block is CoordinationBlock => block.kind === "coordination") ?? null;
}

export function coordinationCounts(members: readonly CoordinationMember[]): {
  asked: number;
  answered: number;
} {
  return {
    asked: members.length,
    answered: members.filter((member) => member.outcome === "answered").length,
  };
}

/**
 * Record one member's outcome on its coordination block, returning the next
 * blocks when they change. Adds a member that is missing (an ask retried in the
 * same round), keeps the first terminal outcome (idempotent for replays), and
 * never downgrades a settled member back to pending.
 */
export function withCoordinationOutcome(
  block: CoordinationBlock,
  member: { botId: string; name: string },
  outcome: CoordinationOutcome,
  reason?: string,
  updatedAt?: string,
): CoordinationBlock {
  const settled: CoordinationOutcome[] = ["answered", "failed", "stopped"];
  const existing = block.members.find((candidate) => candidate.botId === member.botId);
  if (existing) {
    if (settled.includes(existing.outcome) && outcome !== "waiting") return block;
    if (existing.outcome === outcome && (reason ?? undefined) === existing.reason) return block;
  }
  const row: CoordinationMember = {
    botId: member.botId,
    name: member.name,
    outcome,
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
  };
  return {
    ...block,
    members: existing
      ? block.members.map((candidate) => (candidate.botId === member.botId ? row : candidate))
      : [...block.members, row],
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/**
 * Append one coordinator progress note to the round's block. Capped so a chatty
 * coordinator cannot grow the stored message without bound.
 */
export const COORDINATION_UPDATES_MAX = 6;

export function withCoordinationUpdate(
  block: CoordinationBlock,
  note: string,
  updatedAt?: string,
): CoordinationBlock {
  const text = note.trim();
  if (!text) return block;
  const updates = [...block.updates, text].slice(-COORDINATION_UPDATES_MAX);
  return { ...block, updates, ...(updatedAt ? { updatedAt } : {}) };
}

/** Whether the collapsed line should offer a fix for a failed member. */
export function fixableFailure(member: CoordinationMember): boolean {
  return member.outcome === "failed" && FIXABLE_REASON.test(member.reason ?? "");
}

// Causes the owner can act on from the failed member's own model settings:
// account or access problems with the member's model. The writer keeps the
// reason in plain words; this recognizes those plain words.
const FIXABLE_REASON =
  /model account|sign in|subscription|credits|api key|not connected|model set for this group|rate limit|model may not be available|quota/i;

/**
 * The plain sentence a failed member's row shows, from the classified provider
 * failure. Raw provider text never reaches the room; the owner can ask the
 * coordinator (or expand the round) for more.
 */
export function coordinationFailureReason(input: {
  botName: string;
  providerErrorKind?: string;
  error?: string;
}): string | undefined {
  const name = input.botName.trim() || "This member";
  switch (input.providerErrorKind) {
    case "auth":
      return `${name} couldn't answer: its model account needs attention`;
    case "rate-limit":
      return `${name} couldn't answer: its model account hit a rate limit`;
    case "model-unavailable":
      return `${name} couldn't answer: its model is unavailable`;
    default:
      return input.error?.trim() ? `${name} couldn't answer` : undefined;
  }
}

/**
 * Members whose outcome the owner may still want called out on the collapsed
 * line: anyone who did not answer. Answered members already spoke in the room,
 * so the line only counts them.
 */
export function outstandingMembers(members: readonly CoordinationMember[]): CoordinationMember[] {
  return members.filter((member) => member.outcome !== "answered");
}
