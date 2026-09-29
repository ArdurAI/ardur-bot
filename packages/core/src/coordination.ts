import type { MessageBlock } from "@ardurbot/contracts";

/** The coordination block, as stored by a coordinator's ask_members call. */
export type CoordinationBlock = Extract<MessageBlock, { kind: "coordination" }>;

export type CoordinationMember = CoordinationBlock["members"][number];

/** A member outcome as recorded in the coordination block. */
export type CoordinationOutcome = CoordinationMember["outcome"];

/** Why a failed member could not answer; each screen translates the code. */
export type CoordinationFailureCode = NonNullable<CoordinationMember["reasonCode"]>;

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
  reasonCode?: CoordinationFailureCode,
  updatedAt?: string,
): CoordinationBlock {
  const settled: CoordinationOutcome[] = ["answered", "failed", "stopped"];
  const existing = block.members.find((candidate) => candidate.botId === member.botId);
  if (existing) {
    if (settled.includes(existing.outcome) && outcome !== "waiting") return block;
    if (existing.outcome === outcome && (reasonCode ?? undefined) === existing.reasonCode)
      return block;
  }
  const row: CoordinationMember = {
    botId: member.botId,
    name: member.name,
    outcome,
    ...(reasonCode ? { reasonCode } : {}),
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

/**
 * The failure code a failed member's row is stored with, from the classified
 * provider failure. Raw provider text never reaches the room; the owner can
 * ask the coordinator (or expand the round) for more.
 */
export function coordinationFailureCode(input: {
  providerErrorKind?: string;
  error?: string;
}): CoordinationFailureCode | undefined {
  switch (input.providerErrorKind) {
    case "auth":
      return "auth";
    case "rate-limit":
      return "rate-limit";
    case "model-unavailable":
      return "model-unavailable";
    default:
      return input.error?.trim() ? "other" : undefined;
  }
}

// Early rounds stored the reason as an English sentence. Reading maps those
// known sentences back to their code so old rounds render translated text.
const LEGACY_REASON_CODES: [RegExp, CoordinationFailureCode][] = [
  [/model account needs attention/i, "auth"],
  [/hit a rate limit/i, "rate-limit"],
  [/model is unavailable/i, "model-unavailable"],
  [/stopped before answering/i, "stopped"],
  [/couldn't answer/i, "other"],
];

function legacyReasonCode(reason: string | undefined): CoordinationFailureCode | undefined {
  const text = reason?.trim();
  if (!text) return undefined;
  for (const [pattern, code] of LEGACY_REASON_CODES) if (pattern.test(text)) return code;
  return undefined;
}

/**
 * The code a failed member renders with: its stored code, or the code its old
 * English sentence maps to. Anything unrecognised shows the generic line.
 */
export function coordinationMemberFailureCode(member: CoordinationMember): CoordinationFailureCode {
  return member.reasonCode ?? legacyReasonCode(member.reason) ?? "other";
}

/** Whether the collapsed line should offer a fix for a failed member. */
export function fixableFailure(member: CoordinationMember): boolean {
  // Causes the owner can act on from the failed member's own model settings:
  // account or access problems with the member's model, or switching the model
  // after a rate limit. Derived from the code, never from wording.
  const FIXABLE_CODES: CoordinationFailureCode[] = ["auth", "rate-limit", "model-unavailable"];
  return (
    member.outcome === "failed" && FIXABLE_CODES.includes(coordinationMemberFailureCode(member))
  );
}

/**
 * Members whose outcome the owner may still want called out on the collapsed
 * line: anyone who did not answer. Answered members already spoke in the room,
 * so the line only counts them.
 */
export function outstandingMembers(members: readonly CoordinationMember[]): CoordinationMember[] {
  return members.filter((member) => member.outcome !== "answered");
}
