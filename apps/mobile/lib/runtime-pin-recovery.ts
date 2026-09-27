import type { RuntimeProblem } from "@ardurbot/contracts";

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
