import type { RuntimeProblem } from "@ardurbot/contracts";

export function runtimePinRecovery(problem: RuntimeProblem, botId: string) {
  return {
    connect: { pathname: "/models" as const, params: { provider: problem.pin.provider ?? "" } },
    changePin: { pathname: "/bot-settings" as const, params: { botId } },
  };
}
