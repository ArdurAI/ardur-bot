import type { RuntimeProblem } from "@ardurbot/contracts";
import { t } from "./i18n";

export function antigravityProblemMessage(problem: RuntimeProblem): string {
  if (problem.code === "pin-model-unknown")
    return t("Antigravity did not recognise the model {model}. Pick a model from its list.", {
      model: problem.pin.modelId ?? "",
    });
  if (
    problem.reason ===
    "Antigravity tried to use its own tools, which Ardur does not allow yet. The turn was stopped."
  )
    return t(
      "Antigravity tried to use its own tools, which Ardur does not allow yet. The turn was stopped.",
    );
  return t("Antigravity could not run this turn: {reason}.", {
    reason: problem.reason.replace(/^Antigravity could not run this turn: /, "").replace(/\.$/, ""),
  });
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
