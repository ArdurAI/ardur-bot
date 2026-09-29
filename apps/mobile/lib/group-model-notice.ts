import type { GroupModelFailureNotice } from "@ardurbot/contracts";
import { t } from "./i18n";

export function groupModelNoticeText(notice: GroupModelFailureNotice): string {
  if (notice.id === "group-model-locality-denied")
    return t(
      "This group's model is blocked by the bot or space settings. Change the destination policy or choose another group model.",
    );
  if (notice.id === "group-model-credential-missing")
    return t(
      "{botName} couldn't use the model set for this group. Reconnect it or change the group model.",
      { botName: notice.botName },
    );
  if (notice.id === "group-model-usage-limit")
    return t(
      "{botName} hit the group model's usage limit. Try again after it resets, or change the group model.",
      { botName: notice.botName },
    );
  if (notice.id === "group-model-sign-in-expired")
    return t(
      "{botName}'s sign-in for the group model expired. Reconnect it or change the group model.",
      { botName: notice.botName },
    );
  return t(
    "{botName} couldn't use the model set for this group. Change the group model or check this bot's settings.",
    { botName: notice.botName },
  );
}
