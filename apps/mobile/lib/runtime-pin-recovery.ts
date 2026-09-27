import type { RuntimeProblem } from "@ardurbot/contracts";
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
  return {
    connect:
      problem.pin.runtimeKind === "pi"
        ? { pathname: "/models" as const, params: { provider: problem.pin.provider ?? "", botId } }
        : { pathname: "/bot-settings" as const, params: { botId } },
    changePin: { pathname: "/bot-settings" as const, params: { botId } },
  };
}
