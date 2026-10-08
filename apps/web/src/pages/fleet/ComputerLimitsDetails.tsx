import type { ComputerStatus } from "@ardurbot/contracts";
import { currentComputerLimits } from "@ardurbot/contracts";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

export function ComputerLimitsDetails({ bot }: { bot: { id: string; name: string } }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!open) return;
    let active = true;
    const refresh = () =>
      void rpc.computer
        .status({ botId: bot.id, includeLimits: true })
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => {
          if (active) setStatus(null);
        });
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [bot.id, open]);
  const limits = currentComputerLimits(status?.appliedLimits);
  const time = limits ? new Date(limits.observedAt).toLocaleTimeString() : "";
  return (
    <details
      className="text-xs text-muted-foreground"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer">{bot.name}</summary>
      {open ? (
        status?.executionBoundary === "host-account" ? (
          <p>
            <Trans>Host account</Trans>
          </p>
        ) : (
          <>
            <p className="mt-2 font-medium">
              <Trans>Applied limits</Trans>
            </p>
            <dl className="grid grid-cols-2 gap-x-4">
              <dt>
                <Trans>CPU</Trans>
              </dt>
              <dd>{limits?.cpuCores ?? t`Not reported`}</dd>
              <dt>
                <Trans>Memory</Trans>
              </dt>
              <dd>
                {limits?.memoryBytes
                  ? `${(limits.memoryBytes / 1024 ** 2).toLocaleString()} MiB`
                  : t`Not reported`}
              </dd>
              <dt>
                <Trans>Processes</Trans>
              </dt>
              <dd>{limits?.processes ?? t`Not reported`}</dd>
            </dl>
            {limits ? <p>{t`Checked ${time}`}</p> : null}
          </>
        )
      ) : null}
    </details>
  );
}
