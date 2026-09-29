import type { ComputerStatus } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { computerTakeoverBlocked } from "../../lib/thread-events";

export function TakeControlButton({
  computer,
  runStatus,
  taking,
  onTakeControl,
}: {
  computer: ComputerStatus | null;
  runStatus?: string | null;
  taking: boolean;
  onTakeControl: () => void;
}) {
  const { t } = useLingui();
  // The server refuses takeover while a bot run is working, so the run has to stop first.
  if (computerTakeoverBlocked(computer, runStatus)) return null;
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
