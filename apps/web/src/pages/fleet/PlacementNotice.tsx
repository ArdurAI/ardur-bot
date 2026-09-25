import type { Run } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";

export function PlacementNotice({
  run,
  onOpen,
}: {
  run: Pick<Run, "status" | "placement">;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  if (run.status !== "waiting_input" || run.placement?.status !== "pending") return null;
  const name = run.placement.targetName ?? t`computer`;
  return (
    <div
      className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-sm"
      role="status"
    >
      <span>
        <Trans>Move to {name}?</Trans>
      </span>
      <Button variant="outline" onClick={onOpen}>
        <Trans>Computers</Trans>
      </Button>
    </div>
  );
}
