import type {
  HermesRuntimeConfigV2,
  HistoricalHermesRuntimeConfig,
} from "@ardurbot/contracts/runtime-config";
import { effectiveHermesRuntimeConfigV2 } from "@ardurbot/core/runtime-config";
import { Input } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { useId } from "react";

export function HermesLimits({
  value,
  onChange,
}: {
  value: HistoricalHermesRuntimeConfig | null;
  onChange: (value: HermesRuntimeConfigV2) => void;
}) {
  const id = useId();
  const settings = effectiveHermesRuntimeConfigV2(value);
  return (
    <div className="mt-3 grid grid-cols-2 gap-3">
      <label htmlFor={`${id}-calls`} className="text-sm text-muted-foreground">
        <Trans>Model calls per turn</Trans>
        <Input
          id={`${id}-calls`}
          type="number"
          min={1}
          max={64}
          step={1}
          value={settings.limits.maxProviderRequests}
          onChange={(event) =>
            onChange({
              ...settings,
              limits: { ...settings.limits, maxProviderRequests: Number(event.target.value) },
            })
          }
        />
      </label>
      <label htmlFor={`${id}-time`} className="text-sm text-muted-foreground">
        <Trans>Time limit</Trans>
        <Input
          id={`${id}-time`}
          type="number"
          min={1}
          max={600}
          step={1}
          value={settings.limits.timeoutMs / 1_000}
          onChange={(event) =>
            onChange({
              ...settings,
              limits: { ...settings.limits, timeoutMs: Number(event.target.value) * 1_000 },
            })
          }
        />
      </label>
    </div>
  );
}
