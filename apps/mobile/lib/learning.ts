import {
  LearningActionSchema,
  LearningInboxSchema,
  LearningProposalSchema,
  ProposalEvidenceSchema,
  SpaceLearningConfigSchema,
} from "@ardurbot/contracts";
import { RpcServerError, rpc } from "./api";

export async function loadLearning(botId?: string) {
  return LearningInboxSchema.parse(await rpc("learning/list", { botId }));
}
export async function loadLearningProposal(proposalId: string) {
  return LearningProposalSchema.parse(await rpc("learning/proposal", { proposalId }));
}
export async function learningAction(action: "approve" | "reject" | "revert", proposalId: string) {
  return LearningActionSchema.parse(await rpc(`learning/${action}`, { proposalId }));
}
export async function loadLearningSettings() {
  return SpaceLearningConfigSchema.parse(await rpc("learning/settings", {}));
}
export async function enableLearningReview(settings: {
  reviewerPin: unknown;
  destination: unknown;
  consolidationEnabled: boolean;
  budgets: unknown;
}) {
  return SpaceLearningConfigSchema.parse(
    await rpc("learning/configure", {
      enabled: true,
      reviewerPin: settings.reviewerPin ?? settings.destination,
      consolidationEnabled: settings.consolidationEnabled,
      budgets: settings.budgets,
    }),
  );
}
export async function loadLearningEvidence(proposalId: string, evidenceId: string) {
  return ProposalEvidenceSchema.parse(await rpc("learning/evidence", { proposalId, evidenceId }));
}
// The server flattens an unmapped error to this fixed text before it reaches the client.
const GENERIC_RPC_ERROR_MESSAGE = "Internal Server Error";
/**
 * The server's own sentence when a request failed for a reason worth saying, or the fallback.
 * Only a message the server actually sent qualifies: a transport failure (offline, timed out,
 * a response with no message at all) throws a plain `Error` instead, which always falls back,
 * so an untranslated English detail never replaces the caller's translated fallback text.
 */
export function actionMessage(error: unknown, fallback: string): string {
  return error instanceof RpcServerError &&
    error.message &&
    error.message !== GENERIC_RPC_ERROR_MESSAGE
    ? error.message
    : fallback;
}
/** The diff comes from the server, never reviewer-authored markup. */
export function learningBeforeAfter(diff: string) {
  const lines = diff.split("\n").slice(2);
  return {
    before: lines
      .filter((line) => line.startsWith("-"))
      .map((line) => line.slice(1))
      .join("\n"),
    after: lines
      .filter((line) => line.startsWith("+"))
      .map((line) => line.slice(1))
      .join("\n"),
  };
}
