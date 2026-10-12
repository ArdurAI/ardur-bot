import { GOAL_FREEZE_CANCELLED, goalDisplayText } from "@ardurbot/contracts";
import { i18n } from "@lingui/core";

export function translatedGoalText(text: string): string {
  if (!text.split("\n").includes(GOAL_FREEZE_CANCELLED)) return text;
  return goalDisplayText(text, i18n._("The goal reached owner review before this work started."));
}
