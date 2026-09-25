import type { UsagePeriod, UsageSummary } from "@ardurbot/contracts";
import { sparklinePoints } from "@ardurbot/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { rpc } from "../../lib/rpc";
import type { PanelContext } from "./panels";

export async function load(context: PanelContext) {
  const value = await rpc.usage.summary(undefined, {
    signal: context.signal,
    context: { spaceId: context.spaceId },
  });
  return value.providers.length ? value : null;
}
export default function UsagePanel({ data }: { data: UsageSummary }) {
  const { t } = useLingui();
  return (
    <div className="space-y-4 text-sm">
      {data.providers.map((provider) => (
        <div key={provider.provider}>
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-medium">{provider.provider}</h3>
            <svg
              viewBox="0 0 120 32"
              role="img"
              aria-label={t`Tokens over seven days`}
              className="h-8 w-28 text-foreground"
            >
              <polyline
                points={sparklinePoints(provider.daily.map((day) => day.tokens))}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </div>
          <p className="mt-2 text-muted-foreground">
            <Trans>Today (UTC)</Trans>
          </p>
          <Period value={provider.today} />
          <p className="mt-2 text-muted-foreground">
            <Trans>This week (UTC)</Trans>
          </p>
          <Period value={provider.week} />
        </div>
      ))}
    </div>
  );
}
function Period({ value }: { value: UsagePeriod }) {
  const { t } = useLingui();
  const records = value.records;
  const tokens = value.inputTokens + value.outputTokens;
  return (
    <p className="tabular-nums">
      {t`${records} usage records`}
      {" · "}
      {t`${tokens} tokens`}
      {value.cost !== null ? (
        <>
          {" "}
          · <Trans>Cost</Trans>:{" "}
          {value.cost.toLocaleString(undefined, { maximumFractionDigits: 6 })}
        </>
      ) : null}
    </p>
  );
}
