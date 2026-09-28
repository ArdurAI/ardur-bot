import type { HermesRuntimeConfig } from "@ardurbot/contracts";
import { Input } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { useId } from "react";

export function HermesLimits({
  value,
  onChange,
}: {
  value: HermesRuntimeConfig;
  onChange: (value: HermesRuntimeConfig) => void;
}) {
  const id = useId();
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
          value={value.maxProviderRequests}
          onChange={(event) =>
            onChange({ ...value, maxProviderRequests: Number(event.target.value) })
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
          value={value.timeoutMs / 1_000}
          onChange={(event) =>
            onChange({ ...value, timeoutMs: Number(event.target.value) * 1_000 })
          }
        />
      </label>
    </div>
  );
}
