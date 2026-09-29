import type {
  ModelCatalogEntry,
  ModelCredential,
  RuntimePin,
  ThinkingLevel,
} from "@ardurbot/contracts";
import {
  LearningActionSchema,
  LearningInboxSchema,
  LearningProposalSchema,
  ProposalEvidenceSchema,
  SpaceLearningConfigSchema,
} from "@ardurbot/contracts";
import { connectedModelOptions, parseModelPinOptionKey, rpcErrorMessage } from "@ardurbot/core";
import { RpcServerError, rpc } from "./api";

type MenuOption = { label: string; onPress: () => void };

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
/**
 * The server's own sentence when a request failed for a reason worth saying, or the fallback.
 * Only a message the server actually sent qualifies, and only under a code it uses for people:
 * a transport failure (offline, timed out, a response with no message at all) and an error the
 * server did not map both fall back, so untranslated English never replaces the fallback.
 */
export function actionMessage(error: unknown, fallback: string): string {
  return error instanceof RpcServerError ? rpcErrorMessage(error, fallback) : fallback;
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

export function reviewerMenuOptions(
  catalog: ModelCatalogEntry[],
  credentials: ModelCredential[],
  t: (key: string, values?: Record<string, string>) => string,
  onSelect: (pin: {
    runtimeKind: "pi";
    provider: string;
    modelId: string;
    credentialId: string;
  }) => void,
): MenuOption[] {
  const options = connectedModelOptions(catalog, credentials);
  if (options.length === 0) {
    return [{ label: t("Connect a model"), onPress: () => {} }];
  }

  return options.map((opt) => ({
    label: opt.label,
    onPress: () => {
      const selected = parseModelPinOptionKey(opt.key);
      if (!selected?.credentialId) return;
      onSelect({
        runtimeKind: "pi",
        provider: selected.provider,
        modelId: selected.modelId,
        credentialId: selected.credentialId,
      });
    },
  }));
}

export function thinkingMenuOptions(
  supported: ThinkingLevel[],
  isOllama: boolean,
  t: (key: string, values?: Record<string, string>) => string,
  onSelect: (effort: ThinkingLevel) => void,
): MenuOption[] {
  const options = supported.filter((level) =>
    isOllama ? level === "off" || level === "medium" : level !== "off",
  );

  return options.map((level) => ({
    label: isOllama ? (level === "off" ? t("Off") : t("On")) : level,
    onPress: () => onSelect(level),
  }));
}

export async function setReviewerPin(expectedRevision: number, pin: RuntimePin) {
  return SpaceLearningConfigSchema.parse(
    await rpc("learning/setReviewer", {
      expectedRevision,
      pin,
    }),
  );
}
