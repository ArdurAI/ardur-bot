import type { FailureCategoryAction, RuntimeProblem } from "@ardurbot/contracts";
import { FailureCategoryIdSchema, failureCategory } from "@ardurbot/contracts";
import { t } from "./i18n";

export function antigravityProblemMessage(problem: RuntimeProblem): string {
  switch (
    problem.reasonId ??
    (problem.code === "pin-model-unknown" ? "model-unrecognised" : undefined)
  ) {
    case "timeout":
      return t("Antigravity did not finish in time. Try again.");
    case "catalogue-unavailable":
      return t("Antigravity's live model list could not be checked. Check again.");
    case "version-too-old":
      return t("Update Antigravity to version 1.2.12 or later.");
    case "model-unrecognised":
      return t("Antigravity did not recognise the model {model}. Pick a model from its list.", {
        model: problem.pin.modelId ?? "",
      });
    case "native-tool-attempted":
      return t(
        "Antigravity tried to use its own tools, which Ardur does not allow yet. The turn was stopped.",
      );
    case "sign-in-unknown":
      return t("Sign-in unknown until the first run");
    case "signed-out":
      return t("Sign in to Antigravity on this computer, then check again.");
    case "image-unsupported":
      return t("Antigravity cannot use images yet. Remove the image and try again.");
    case "comparison-unsupported":
      return t("Antigravity cannot run comparison turns yet. Choose another runtime.");
    case "input-too-large":
      return t(
        "Antigravity input is too large. Shorten the message or conversation and try again.",
      );
    case "not-installed":
      return t(
        "Antigravity is not installed on this computer. Install it and sign in there, then check again.",
      );
    case "unavailable":
    case "version-unchecked":
    case "probe-failed":
    case "invalid-pin":
    case "effort-unsupported":
    case "tools-unsupported":
    case "resume-unsupported":
    case "host-directory-required":
    case "input-write-failed":
    case "stopped-early":
    case "runtime-error":
    case "invalid-response":
    case "text-too-large":
    case "empty-response":
      return t("Antigravity could not run this turn. Check the runtime and try again.");
    default:
      return problem.reason;
  }
}

export function runtimePinRecovery(problem: RuntimeProblem, botId: string) {
  const groupId = problem.source?.kind === "group-member" ? problem.source.groupId : null;
  return {
    message: groupId
      ? "This bot uses a model chosen for this group. Change it in Group settings."
      : null,
    connect:
      problem.pin.runtimeKind === "pi"
        ? { pathname: "/models" as const, params: { provider: problem.pin.provider ?? "", botId } }
        : { pathname: "/bot-settings" as const, params: { botId } },
    changePin: groupId
      ? { pathname: "/group-settings" as const, params: { groupId } }
      : { pathname: "/bot-settings" as const, params: { botId } },
  };
}

/** Where a failure-category action leads on the phone: a route to push, or the one setting it saves. */
export type FailureCategoryRecoveryAction =
  | {
      kind: "enable-experimental";
      /** Saves runtimeExperimental for this bot the way the bot settings screen does. */
      botId: string;
    }
  | { kind: "route"; pathname: "/bot-settings" | "/models"; params: Record<string, string> };

/**
 * A classified runtime refusal's actions, from the failure-category table, first action
 * first: turn on Experimental, open the bot's settings (the phone has no destinations or
 * computer controls; the pin lives there), open Settings at Models, or change the pin.
 */
export function runtimeRefusalRecovery(
  problem: RuntimeProblem,
  botId: string,
): {
  actions: FailureCategoryRecoveryAction[];
} {
  const category = FailureCategoryIdSchema.safeParse(problem.reasonId);
  const toAction = (action: FailureCategoryAction): FailureCategoryRecoveryAction | null => {
    if (action.kind === "enable-experimental") return { kind: "enable-experimental", botId };
    if (action.kind !== "open-settings") return null;
    return action.target === "space-models"
      ? { kind: "route", pathname: "/models", params: {} }
      : { kind: "route", pathname: "/bot-settings", params: { botId } };
  };
  if (!category.success)
    return { actions: [{ kind: "route", pathname: "/bot-settings", params: { botId } }] };
  const entry = failureCategory(category.data);
  const actions = [entry.action, ...(entry.more ?? [])]
    .map(toAction)
    .filter((action): action is FailureCategoryRecoveryAction => action !== null);
  return {
    actions: actions.length
      ? actions
      : [{ kind: "route", pathname: "/bot-settings", params: { botId } }],
  };
}

/** The phone's label for a refusal action. */
export function runtimeRefusalActionLabel(action: FailureCategoryRecoveryAction): string {
  return action.kind === "enable-experimental"
    ? t("Turn on Experimental")
    : action.pathname === "/models"
      ? t("Open Settings")
      : t("Open bot settings");
}
