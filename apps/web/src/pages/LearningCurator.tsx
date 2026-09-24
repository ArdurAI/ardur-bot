import type { SpaceLearningConfig } from "@ardurbot/contracts";
import { Button, Switch } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

export function LearningCurator({
  settings,
  busy,
  change,
}: {
  settings: SpaceLearningConfig;
  busy: boolean;
  change: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useLingui();
  const [data, setData] = useState<Awaited<ReturnType<typeof rpc.learning.curator>> | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () =>
      void rpc.learning
        .curator()
        .then((v) => {
          if (active) {
            setData(v);
            setError(false);
          }
        })
        .catch(() => {
          if (active) setError(true);
        });
    load();
    const timer = window.setInterval(load, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const last = data?.reports[0];
  return (
    <details className="space-y-2 text-sm">
      <summary>
        <Trans>Curator</Trans>
      </summary>
      <Button disabled={busy} onClick={() => void change(() => rpc.learning.curate({}))}>
        <Trans>Run now</Trans>
      </Button>
      <div className="flex items-center gap-2">
        <Switch
          aria-label={t`Propose consolidation`}
          checked={settings.consolidationEnabled}
          disabled={busy}
          onCheckedChange={(consolidationEnabled) =>
            void change(() =>
              rpc.learning.configure({
                enabled: settings.enabled,
                consolidationEnabled,
                reviewerPin: settings.reviewerPin ?? settings.destination,
                budgets: settings.budgets,
              }),
            )
          }
        />
        <span>
          <Trans>Propose consolidation</Trans>
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        <Trans>
          Consolidation uses the review connection and may incur model charges. Approval is
          required.
        </Trans>
      </p>
      <p className="text-xs">
        {settings.destination?.provider} · {settings.destination?.modelId} ·{" "}
        {settings.destination?.effort}
      </p>
      <details>
        <summary>
          <Trans>Last check</Trans>
        </summary>
        {error ? (
          <p role="alert">
            <Trans>Could not load the last check.</Trans>
          </p>
        ) : last ? (
          <div className="text-xs">
            <p>
              {last.startedAt} · {last.status}
            </p>
            <p>
              <Trans>Checked</Trans>: {last.checked}; <Trans>Stale</Trans>: {last.staleIds.length};{" "}
              <Trans>Flags</Trans>: {last.flaggedIds.length}; <Trans>Proposals</Trans>:{" "}
              {last.proposalIds.length}
            </p>
            <p>
              {last.durationMs} ms · {last.tokens ?? t`Unknown`} <Trans>tokens</Trans>
            </p>
            <p>{[...last.staleIds, ...last.flaggedIds, ...last.proposalIds].join(", ")}</p>
          </div>
        ) : (
          <p>
            <Trans>No checks yet.</Trans>
          </p>
        )}
      </details>
      {data?.skills.map((skill) => (
        <div key={skill.id} className="flex items-center gap-2">
          <span>
            {skill.name}
            {skill.staleAt ? ` · ${t`Stale`}` : ""}
          </span>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void change(async () => {
                await rpc.learning.skillCare({
                  skillId: skill.id,
                  lifecycleTag: skill.lifecycleTag === "normal" ? "recovery" : "normal",
                });
                setData(await rpc.learning.curator());
              })
            }
          >
            {skill.lifecycleTag === "normal" ? t`Keep for recovery` : t`Recovery skill`}
          </Button>
        </div>
      ))}
    </details>
  );
}
