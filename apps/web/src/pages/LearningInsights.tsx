import type {
  InsightAction,
  InsightEvidence,
  InsightTaskKind,
  LearningInsight,
} from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";
import { openInsightAction } from "../lib/insight-actions";
import { actionMessage } from "../lib/orpc-action-message";
import { rpc } from "../lib/rpc";

type T = Pick<I18n, "_">;

function taskLabel(task: InsightTaskKind, i18n: T) {
  if (task === "coding") return i18n._(msg`coding`);
  if (task === "research") return i18n._(msg`research`);
  if (task === "routine") return i18n._(msg`board and routine work`);
  return i18n._(msg`conversation`);
}

function percentLower(better: number | null, other: number | null) {
  return better !== null && other ? Math.round((1 - better / other) * 100) : 0;
}

/** One plain sentence per insight. Comparisons are about the person's runs, never a model in general. */
export function insightSentence(evidence: InsightEvidence, i18n: T): string {
  switch (evidence.kind) {
    case "model-choice": {
      const task = taskLabel(evidence.taskKind, i18n);
      const better = evidence.better.label;
      const other = evidence.other.label;
      const a = evidence.rows.find((row) => row.model.key === evidence.better.key);
      const b = evidence.rows.find((row) => row.model.key === evidence.other.key);
      if (evidence.variant === "completion") {
        const finished = a?.completed ?? 0;
        const total = a?.total ?? 0;
        const otherFinished = b?.completed ?? 0;
        const otherTotal = b?.total ?? 0;
        return i18n._(
          msg`For ${task}, ${better} finished ${finished} of ${total} runs in your runs; ${other} finished ${otherFinished} of ${otherTotal}.`,
        );
      }
      if (evidence.variant === "local")
        return i18n._(
          msg`For ${task}, ${better} on this machine did as well as ${other} in your runs.`,
        );
      if (evidence.variant === "tokens") {
        const percent = percentLower(a?.medianTokens ?? null, b?.medianTokens ?? null);
        return i18n._(
          msg`For ${task}, ${better} finished as often as ${other} in your runs with ${percent}% fewer tokens.`,
        );
      }
      const percent = percentLower(a?.medianMs ?? null, b?.medianMs ?? null);
      return i18n._(
        msg`For ${task}, ${better} finished as often as ${other} in your runs in ${percent}% less time.`,
      );
    }
    case "repeated-failure": {
      const bot = evidence.botName;
      const model = evidence.model.label;
      const count = evidence.streak;
      const suggested = evidence.suggested?.label;
      if (evidence.failure === "tools")
        return suggested
          ? i18n._(
              msg`${bot}'s last ${count} runs on ${model} failed because it cannot use tools; ${suggested} used tools in your runs.`,
            )
          : i18n._(
              msg`${bot}'s last ${count} runs on ${model} failed because it cannot use tools.`,
            );
      if (evidence.failure === "context")
        return suggested
          ? i18n._(
              msg`${bot}'s last ${count} runs on ${model} failed because the conversation was too long for it; ${suggested} takes a larger context.`,
            )
          : i18n._(
              msg`${bot}'s last ${count} runs on ${model} failed because the conversation was too long for it.`,
            );
      if (evidence.failure === "rate-limit")
        return suggested
          ? i18n._(
              msg`${bot}'s last ${count} runs on ${model} were rate limited; ${suggested}, on another provider, is available.`,
            )
          : i18n._(msg`${bot}'s last ${count} runs on ${model} were rate limited.`);
      return i18n._(
        msg`${bot}'s last ${count} runs on ${model} failed because its sign-in was rejected.`,
      );
    }
    case "connection": {
      const connection = evidence.connection;
      const count = evidence.runs;
      return evidence.problem === "rejected"
        ? i18n._(msg`${connection} rejected its sign-in; ${count} runs could not use it.`)
        : i18n._(msg`${count} runs needed ${connection}, which is not connected.`);
    }
    case "memory-search": {
      const count = evidence.documents;
      return i18n._(msg`Most of your ${count} memories never reach your bots.`);
    }
    case "learning-off": {
      const count = evidence.reasons;
      const days = evidence.days;
      return i18n._(
        msg`You gave ${count} thumbs with reasons in ${days} days, but Learning is off.`,
      );
    }
    case "approval": {
      const { tool, botName: bot, approvals: count } = evidence;
      return i18n._(msg`You approved ${tool} for ${bot} ${count} times this week.`);
    }
    case "routine": {
      const { botName: bot, count, days } = evidence;
      return i18n._(msg`You sent ${bot} the same request ${count} times in ${days} days.`);
    }
  }
}

export function insightActionLabel(insight: LearningInsight, i18n: T): string {
  const action = insight.action;
  if (action.kind === "bot-model") return i18n._(msg`Change model`);
  if (action.kind === "connection")
    return insight.evidence.kind === "connection" && insight.evidence.problem === "missing"
      ? i18n._(msg`Connect`)
      : i18n._(msg`Reconnect`);
  if (action.kind === "memory-settings") return i18n._(msg`Set up memory search`);
  if (action.kind === "learning-settings") return i18n._(msg`Enable`);
  if (action.kind === "approval-rule") return i18n._(msg`Always allow`);
  return i18n._(msg`New routine`);
}

function allowQuestion(tool: string, bot: string, i18n: T) {
  return i18n._(msg`Allow ${tool} for ${bot} without asking?`);
}

function duration(ms: number | null) {
  if (ms === null) return "—";
  const seconds = Math.round(ms / 1000);
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

function InsightDetails({ evidence }: { evidence: InsightEvidence }) {
  const { t, i18n } = useLingui();
  const number = (value: number) => value.toLocaleString(i18n.locale);
  if (evidence.kind === "model-choice") {
    const { runs, days } = evidence;
    const priced = evidence.rows.some((row) => row.costUsd !== null);
    return (
      <div className="space-y-2 py-2">
        <p>{t`Based on ${runs} runs in the last ${days} days.`}</p>
        <table className="w-full text-start tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th className="pe-2 text-start font-normal">
                <Trans>Model</Trans>
              </th>
              <th className="pe-2 text-start font-normal">
                <Trans>Finished</Trans>
              </th>
              <th className="pe-2 text-start font-normal">
                <Trans>Thumbs</Trans>
              </th>
              <th className="pe-2 text-start font-normal">
                <Trans>Median time</Trans>
              </th>
              <th className="pe-2 text-start font-normal">
                <Trans>Median tokens</Trans>
              </th>
              {priced ? (
                <th className="text-start font-normal">
                  <Trans>Cost</Trans>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {evidence.rows.map((row) => (
              <tr key={row.model.key}>
                <td className="pe-2">{row.model.label}</td>
                <td className="pe-2">
                  {row.completed}/{row.total}
                </td>
                <td className="pe-2">
                  +{row.thumbsUp} / −{row.thumbsDown}
                </td>
                <td className="pe-2">{duration(row.medianMs)}</td>
                <td className="pe-2">
                  {row.medianTokens === null ? "—" : number(row.medianTokens)}
                </td>
                {priced ? (
                  <td>{row.costUsd === null ? "—" : `$${row.costUsd.toFixed(2)}`}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (evidence.kind === "repeated-failure") {
    const { runs, days, suggestedRuns } = evidence;
    const suggested = evidence.suggested?.label;
    return (
      <div className="space-y-1 py-2">
        <p>{t`Based on ${runs} runs in the last ${days} days.`}</p>
        {suggested && evidence.contextWindow && evidence.suggestedContextWindow ? (
          <p>
            {evidence.model.label}: {number(evidence.contextWindow)} · {suggested}:{" "}
            {number(evidence.suggestedContextWindow)} <Trans>tokens of context</Trans>
          </p>
        ) : null}
        {suggested && suggestedRuns ? (
          <p>{t`${suggested} finished ${suggestedRuns} of your runs.`}</p>
        ) : null}
      </div>
    );
  }
  if (evidence.kind === "connection") {
    const { runs, days } = evidence;
    return <p className="py-2">{t`Based on ${runs} runs in the last ${days} days.`}</p>;
  }
  if (evidence.kind === "memory-search") {
    const { documents } = evidence;
    const kb = Math.round(evidence.bytes / 1024);
    return (
      <p className="py-2">{t`${documents} personal memories, ${kb} KB, and memory search is not set up.`}</p>
    );
  }
  if (evidence.kind === "learning-off") {
    const { reasons, days } = evidence;
    return (
      <p className="py-2">{t`Based on ${reasons} thumbs with reasons in the last ${days} days.`}</p>
    );
  }
  if (evidence.kind === "approval") {
    const { approvals, days } = evidence;
    return (
      <p className="py-2">{t`Based on ${approvals} approvals and no denials in the last ${days} days.`}</p>
    );
  }
  const { count, days } = evidence;
  return (
    <div className="space-y-1 py-2">
      <p className="whitespace-pre-wrap">“{evidence.prompt}”</p>
      <p>{t`Based on ${count} requests in the last ${days} days.`}</p>
    </div>
  );
}

function InsightCard({
  insight,
  busy,
  change,
}: {
  insight: LearningInsight;
  busy: boolean;
  change: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { i18n } = useLingui();
  const [confirming, setConfirming] = useState(false);
  const evidence = insight.evidence;
  const act = (action: InsightAction) =>
    change(async () => {
      await rpc.learning.actOnInsight({ insightId: insight.id });
      openInsightAction(action);
    });
  return (
    <article
      className="rounded-lg border p-3 text-sm"
      data-testid="learning-insight"
      data-kind={evidence.kind}
    >
      <p>{insightSentence(evidence, i18n)}</p>
      {confirming && insight.action.kind === "approval-rule" && evidence.kind === "approval" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span>{allowQuestion(evidence.tool, evidence.botName, i18n)}</span>
          <Button
            disabled={busy}
            onClick={() =>
              void change(() => rpc.learning.allowInsightTool({ insightId: insight.id }))
            }
          >
            <Trans>Allow</Trans>
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              insight.action.kind === "approval-rule"
                ? setConfirming(true)
                : void act(insight.action)
            }
          >
            {insightActionLabel(insight, i18n)}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void change(() => rpc.learning.dismissInsight({ insightId: insight.id }))
            }
          >
            <Trans>Dismiss</Trans>
          </Button>
        </div>
      )}
      <details className="mt-2 text-xs text-muted-foreground">
        <summary>
          <Trans>Details</Trans>
        </summary>
        <InsightDetails evidence={evidence} />
      </details>
    </article>
  );
}

/** At most five, highest impact first. Renders nothing when there is nothing to say. */
export default function LearningInsights({ botId }: { botId?: string }) {
  const { t } = useLingui();
  const [insights, setInsights] = useState<LearningInsight[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      Promise.resolve()
        .then(() => rpc.learning.insights({ botId }))
        .then((result) => setInsights(result.insights)),
    [botId],
  );
  useEffect(() => {
    void load().catch(() => undefined);
    const refresh = () => void load().catch(() => undefined);
    window.addEventListener("learning-changed", refresh);
    return () => window.removeEventListener("learning-changed", refresh);
  }, [load]);
  async function change(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      window.dispatchEvent(new Event("learning-changed"));
    } catch (failure) {
      setError(actionMessage(failure, t`Could not update learning. Try again.`));
    } finally {
      setBusy(false);
    }
  }
  if (!insights.length && !error) return null;
  return (
    <section aria-label={t`Insights`} data-testid="learning-insights" className="space-y-2">
      <h4 className="text-sm font-medium">
        <Trans>Insights</Trans>
      </h4>
      {error ? <p role="alert">{error}</p> : null}
      {insights.map((insight) => (
        <InsightCard key={insight.id} insight={insight} busy={busy} change={change} />
      ))}
    </section>
  );
}
