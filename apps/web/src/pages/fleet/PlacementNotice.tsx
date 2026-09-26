import type { HostLabel, Run } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useTargetName } from "./target-name";

export function PlacementNotice({
  run,
  hostLabel,
  onOpen,
}: {
  run: Pick<Run, "status" | "placement">;
  hostLabel?: HostLabel;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const targetName = useTargetName(hostLabel);
  if (run.status !== "waiting_input" || run.placement?.status !== "pending") return null;
  const name = targetName({
    name: run.placement.targetName ?? t`computer`,
    builtin: run.placement.targetBuiltin,
  });
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
