import type { CoordinationBlock, CoordinationMember } from "@ardurbot/core";
import { coordinationMemberFailureCode, fixableFailure } from "@ardurbot/core";
import { t } from "./i18n";

/** The one-line summary for a collapsed coordination round. */
export function coordinationSummary(block: CoordinationBlock): string {
  const asked = block.members.length;
  const answered = block.members.filter((member) => member.outcome === "answered").length;
  const askedLabel =
    asked === 1 ? t("1 bot", { count: asked }) : t("{count} bots", { count: asked });
  const answeredLabel = t("{count} answered", { count: answered });
  return t("Asked {asked} · {answered}", { asked: askedLabel, answered: answeredLabel });
}

/** The spoken/toggle label for the collapsed coordination round. */
export function coordinationAccessibilityLabel(block: CoordinationBlock): string {
  return coordinationSummary(block);
}

/** The plain line a failed member shows while collapsed, translated from its reason code. */
export function coordinationFailureLine(member: CoordinationMember): string {
  const name = member.name;
  switch (coordinationMemberFailureCode(member)) {
    case "auth":
      return t("{name} couldn't answer: its model account needs attention", { name });
    case "rate-limit":
      return t("{name} couldn't answer: its model account hit a rate limit", { name });
    case "model-unavailable":
      return t("{name} couldn't answer: its model is unavailable", { name });
    case "stopped":
      return t("{name} stopped before answering", { name });
    default:
      return t("{name} couldn't answer", { name });
  }
}

/** Whether the failed member's line should offer a fix link. */
export function coordinationFailureFixable(member: CoordinationMember): boolean {
  return fixableFailure(member);
}

/** The outcome word for one member row, expanded. */
export function coordinationMemberOutcome(member: CoordinationMember): string {
  switch (member.outcome) {
    case "answered":
      return t("answered");
    case "failed":
      return t("couldn't answer");
    case "stopped":
      return t("stopped before answering");
    case "waiting":
      return t("is waiting for you");
    default:
      return t("has not answered yet");
  }
}
