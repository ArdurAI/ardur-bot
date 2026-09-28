import type {
  HermesRuntimeConfigV2,
  HistoricalHermesRuntimeConfig,
} from "@ardurbot/contracts/runtime-config";
import { effectiveHermesRuntimeConfigV2 } from "@ardurbot/core/runtime-config";
import { Input } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";

export function HermesLimits({
  value,
  onChange,
}: {
  value: HistoricalHermesRuntimeConfig | null;
  onChange: (value: HermesRuntimeConfigV2) => void;
}) {
  const id = useId();
  const settings = effectiveHermesRuntimeConfigV2(value);

  const [calls, setCalls] = useState(String(settings.limits.maxProviderRequests));
  const [time, setTime] = useState(String(settings.limits.timeoutMs / 1_000));

  useEffect(() => {
    setCalls(String(settings.limits.maxProviderRequests));
  }, [settings.limits.maxProviderRequests]);

  useEffect(() => {
    setTime(String(settings.limits.timeoutMs / 1_000));
  }, [settings.limits.timeoutMs]);

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
          value={calls}
          onChange={(event) => {
            const val = event.target.value;
            setCalls(val);
            const num = Number(val);
            if (num >= 1 && num <= 64) {
              onChange({ ...settings, limits: { ...settings.limits, maxProviderRequests: num } });
            }
          }}
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
          value={time}
          onChange={(event) => {
            const val = event.target.value;
            setTime(val);
            const num = Number(val);
            if (num >= 1 && num <= 600) {
              onChange({ ...settings, limits: { ...settings.limits, timeoutMs: num * 1_000 } });
            }
          }}
        />
      </label>
    </div>
  );
}
