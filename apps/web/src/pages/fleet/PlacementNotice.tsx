import type { HostLabel, Run } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";

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
  if (run.status !== "waiting_input" || run.placement?.status !== "pending") return null;
  const mac = hostLabel === "This Mac";
  const name =
    run.placement.targetBuiltin === "host"
      ? mac
        ? t`This Mac`
        : t`This computer`
      : run.placement.targetBuiltin === "local-docker"
        ? mac
          ? t`Docker on this Mac`
          : t`Docker on this computer`
        : run.placement.targetBuiltin === "default"
          ? t`Default computer`
          : (run.placement.targetName ?? t`computer`);
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
