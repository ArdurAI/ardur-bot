import { t } from "@lingui/core/macro";

export interface WorkingIndicatorBot {
  name?: string;
  status?: string;
  /** The bot's run is waiting out a provider's rate limit before it tries again. */
  retrying?: boolean;
}

/**
 * The thread's working indicator. A room bot whose run is still queued is waiting for a
 * free place, and a bot whose run is queued to retry a provider's rate limit is waiting
 * for the model; the row says so only while every listed bot waits the same way.
 */
export function workingIndicatorLabel(
  bots: readonly WorkingIndicatorBot[],
  options: { room: boolean },
): string {
  if (bots.length > 0 && bots.every((bot) => bot.retrying)) {
    return t`Waiting for the model`;
  }
  if (
    options.room &&
    bots.length > 0 &&
    bots.every((bot) => bot.status === "queued" && !bot.retrying)
  ) {
    return t`Waiting for a free place`;
  }
  const workingBotName = bots.length === 1 ? bots[0]?.name : undefined;
  return workingBotName != null && workingBotName !== ""
    ? t`${workingBotName} is working`
    : t`Bots are working`;
}
