import type { ComputerStatus, Run } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { computerTakeoverBlocked } from "../../lib/thread-events";

export function TakeControlButton({
  computer,
  runs,
  botId,
  taking,
  onTakeControl,
}: {
  computer: ComputerStatus | null;
  runs: readonly Run[];
  botId: string;
  taking: boolean;
  onTakeControl: () => void;
}) {
  const { t } = useLingui();
  // The server refuses takeover while the computer's bot is working, so its run has to stop first.
  if (computerTakeoverBlocked(computer, runs, botId)) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={taking}
      aria-label={t`Take control`}
      onClick={onTakeControl}
    >
      <Trans>Take control</Trans>
    </Button>
  );
}
