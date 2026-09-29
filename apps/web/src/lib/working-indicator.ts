import { t } from "@lingui/core/macro";

export interface WorkingIndicatorBot {
  name?: string;
  status?: string;
}

/**
 * The thread's working indicator. A room bot whose run is still queued is waiting for a
 * free place, not working; the row says so only while every listed bot waits.
 */
export function workingIndicatorLabel(
  bots: readonly WorkingIndicatorBot[],
  options: { room: boolean },
): string {
  if (options.room && bots.length > 0 && bots.every((bot) => bot.status === "queued")) {
    return t`Waiting for a free place`;
  }
  const workingBotName = bots.length === 1 ? bots[0]?.name : undefined;
  return workingBotName != null && workingBotName !== ""
    ? t`${workingBotName} is working`
    : t`Bots are working`;
}
