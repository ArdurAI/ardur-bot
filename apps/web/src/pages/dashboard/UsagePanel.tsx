import type { UsagePeriod, UsageSummary } from "@ardurbot/contracts";
import { sparklinePoints } from "@ardurbot/core";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
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
      {data.bots?.length ? (
        <ul className="space-y-4" aria-label={t`By bot`}>
          {data.bots.map((bot) => (
            <li key={bot.botId ?? "unattributed"}>
              <h3 className="font-medium">
                {bot.name ?? (bot.botId ? t`Unknown bot` : t`Unattributed usage`)}
              </h3>
              <p className="mt-2 text-muted-foreground">
                <Trans>Today (UTC)</Trans>
              </p>
              <Period value={bot.today} />
              <p className="mt-2 text-muted-foreground">
                <Trans>This week (UTC)</Trans>
              </p>
              <Period value={bot.week} />
              {bot.providers.length > 1 ? (
                <ul className="mt-2 space-y-2">
                  {bot.providers.map((provider) => (
                    <li key={provider.provider}>
                      <span className="text-muted-foreground">
                        {provider.provider} · <Trans>This week (UTC)</Trans>
                      </span>
                      <Period value={provider.week} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
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
  const records = value.records;
  const runs = value.runs;
  const cost = value.knownCost ?? value.cost;
  const tokens = value.inputTokens + value.outputTokens;
  return (
    <p className="tabular-nums">
      {runs === undefined ? null : (
        <>
          <Plural value={runs} one="# run" other="# runs" />
          {" · "}
        </>
      )}
      <Plural value={records} one="# usage record" other="# usage records" />
      {" · "}
      <Plural value={tokens} one="# token" other="# tokens" />
      {cost !== null ? (
        <>
          {" · "}
          {value.costStatus === "partial" ? <Trans>Partial cost</Trans> : <Trans>Cost</Trans>}:{" "}
          {cost.toLocaleString(undefined, { maximumFractionDigits: 6 })}
        </>
      ) : (
        <>
          {" · "}
          <Trans>Cost unavailable</Trans>
        </>
      )}
      {value.incomplete ? (
        <>
          {" "}
          · <Trans>Partially reported</Trans>
        </>
      ) : null}
    </p>
  );
}
