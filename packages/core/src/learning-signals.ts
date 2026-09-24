import type { MessageBlock, ProposalEvidence } from "@ardurbot/contracts";
import { createStreamingRedactor } from "./events.js";

/** Shared, deterministic redaction for review input, output, and feedback. Never logs input. */
export function redactLearningText(text: string, knownSecrets: readonly string[] = []): string {
  const stream = createStreamingRedactor([...knownSecrets]);
  return (stream.push(text) + stream.finish())
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
      "[Redacted]",
    )
    .replace(
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bsk-[A-Za-z0-9_-]{8,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+/gu,
      "[Redacted]",
    )
    .replace(/\bBearer\s+[^\s"',;&]+/giu, "Bearer [Redacted]")
    .replace(
      /\b[A-Za-z0-9_]*(?:password|passwd|secret|token|authorization|api_key|apikey|cookie)[A-Za-z0-9_]*\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/giu,
      "[Redacted]",
    )
    .replace(/:\/\/[^\s/:]+:[^\s/@]+@/gu, "://[Redacted]@")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[Redacted]");
}

export type LearningMessage = {
  id: string;
  origin: string;
  actorId: string | null;
  blocks: MessageBlock[];
  steeringKind?: "correction" | "added-requirement" | "other";
};
export interface LearningSignalRecords {
  runId: string;
  threadId: string;
  userId: string;
  messages: LearningMessage[];
  feedback: Array<{
    id: string;
    actorId: string;
    reason: string | null;
    rating: string;
    retractedAt: Date | null;
  }>;
  outcomes: Array<{
    id: string;
    eventIds?: string[];
    sourceClass: "run" | "tool" | "approval" | "usage";
    outcome: NonNullable<ProposalEvidence["outcome"]>;
  }>;
}

/** Mixed/quoted material has no safe span attribution. Defer it instead of asking a model to guess. */
export function humanInstructionSpan(text: string): string | null {
  if (/```|~~~|^\s*>|<\/?[a-z]|https?:\/\/|\b(?:attached|quoted|pasted|forwarded)\b/imu.test(text))
    return null;
  return text.trim().slice(0, 1000) || null;
}

export function buildLearningSignals(
  records: LearningSignalRecords,
  knownSecrets: readonly string[] = [],
): {
  authorisedIntent: ProposalEvidence[];
  observedOutcomes: ProposalEvidence[];
} {
  const authorisedIntent: ProposalEvidence[] = [];
  const observedOutcomes: ProposalEvidence[] = [];
  const base = {
    runId: records.runId,
    threadId: records.threadId,
    redactionVersion: 1 as const,
    eventIds: [] as string[],
  };
  for (const message of records.messages) {
    // Origin comes from server intake. A user role, claimed author, or summary cannot upgrade it.
    if (message.origin !== "human-typed" || message.actorId !== records.userId) continue;
    if (message.blocks.length !== 1 || message.blocks[0]?.kind !== "text") continue;
    const excerpt = humanInstructionSpan(redactLearningText(message.blocks[0].text, knownSecrets));
    if (!excerpt) continue;
    authorisedIntent.push({
      ...base,
      id: `message:${message.id}`,
      kind: "instruction-span",
      sourceClass: message.steeringKind ? "human-steering" : "human-message",
      actorId: message.actorId,
      excerpt,
    });
  }
  for (const feedback of records.feedback) {
    if (feedback.retractedAt || feedback.actorId !== records.userId) continue;
    observedOutcomes.push({
      ...base,
      id: `feedback:${feedback.id}`,
      kind: "observed-outcome",
      sourceClass: "feedback",
      actorId: feedback.actorId,
      outcome: {
        category: "feedback",
        classification: feedback.rating === "positive" ? "positive" : "negative",
      },
    });
    const excerpt =
      feedback.reason && humanInstructionSpan(redactLearningText(feedback.reason, knownSecrets));
    if (excerpt)
      authorisedIntent.push({
        ...base,
        id: `reason:${feedback.id}`,
        kind: "instruction-span",
        sourceClass: "feedback-reason",
        actorId: feedback.actorId,
        excerpt,
      });
  }
  for (const record of records.outcomes)
    observedOutcomes.push({
      ...base,
      id: record.id,
      kind: "observed-outcome",
      sourceClass: record.sourceClass,
      outcome: record.outcome,
      eventIds: record.eventIds ?? [],
    });
  return { authorisedIntent, observedOutcomes };
}

export function learningEligibility(input: {
  evidenceCount: number;
  evidenceWatermark: string;
  previousWatermark?: string;
  duplicate: boolean;
  remainingTokens: number;
  requiredTokens: number;
  protectedOnly: boolean;
}): "eligible" | "no-evidence" | "no-new-evidence" | "duplicate" | "budget" | "protected" {
  if (!input.evidenceCount) return "no-evidence";
  if (input.previousWatermark === input.evidenceWatermark) return "no-new-evidence";
  if (input.duplicate) return "duplicate";
  if (input.protectedOnly) return "protected";
  if (input.requiredTokens > input.remainingTokens) return "budget";
  return "eligible";
}
