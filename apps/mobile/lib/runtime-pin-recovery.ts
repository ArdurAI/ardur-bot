import type { RuntimeProblem } from "@ardurbot/contracts";

export function runtimePinRecovery(problem: RuntimeProblem, botId: string) {
  return {
    connect:
      problem.pin.runtimeKind === "pi"
        ? { pathname: "/models" as const, params: { provider: problem.pin.provider ?? "", botId } }
        : { pathname: "/bot-settings" as const, params: { botId } },
    changePin: { pathname: "/bot-settings" as const, params: { botId } },
  };
}
