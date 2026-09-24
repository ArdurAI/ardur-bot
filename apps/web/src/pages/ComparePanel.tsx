import { ChatMarkdown } from "@ardurbot/chat-ui/web";
import type { Bot, Comparison, ComparisonParticipant, ComparisonResult } from "@ardurbot/contracts";
import { runtimeEffortLabel, TEAM_REFRESH_MS } from "@ardurbot/core";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTitle,
  NativeSelect,
  NativeSelectOption,
} from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";
import { AskCard } from "../components/AskCard";
import { downloadArtifactBytes } from "../lib/artifact-open";
import { rpc } from "../lib/rpc";

export function ComparePanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useLingui();
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [mergeBotId, setMergeBotId] = useState("");
  const [mergePreview, setMergePreview] = useState<ComparisonParticipant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const next = await rpc.comparisons.get({ id });
    setComparison(next);
    setMergeBotId((value) => value || next.coordinatorBotId);
  }, [id]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await rpc.comparisons.get({ id });
        if (active) {
          setComparison(next);
          setMergeBotId((value) => value || next.coordinatorBotId);
        }
      } catch {
        if (active) setError(t`Could not load comparison; retry.`);
      }
    };
    void load();
    void rpc.bots
      .list()
      .then((next) => {
        if (active) setBots(next);
      })
      .catch(() => {});
    const timer = setInterval(() => void load(), TEAM_REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id, t]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch {
      setError(t`Could not update comparison; retry.`);
    } finally {
      setBusy(false);
    }
  };
  const count = comparison?.participants.length ?? 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-screen w-full max-w-none flex-col overflow-auto sm:max-w-none"
        data-testid="compare-panel"
      >
        <DialogTitle>
          <Trans>Same task, {count} bots</Trans>
        </DialogTitle>
        {error ? (
          <Button variant="ghost" onClick={() => void act(refresh)}>
            {error}
          </Button>
        ) : null}
        {comparison ? (
          <>
            <details>
              <summary>
                <Trans>Inputs</Trans>
              </summary>
              <p className="whitespace-pre-wrap">{comparison.snapshot.text}</p>
              <p>{comparison.snapshot.artifacts.map((item) => item.name).join(", ")}</p>
              <p className="whitespace-pre-wrap">{comparison.snapshot.environmentNote}</p>
            </details>
            <div
              className="grid gap-4 overflow-x-auto"
              style={{ gridTemplateColumns: `repeat(${count}, minmax(20rem, 1fr))` }}
            >
              {comparison.participants.map((participant) => {
                const result = comparison.results.find(
                  (result) => result.botId === participant.botId,
                );
                return (
                  <article
                    key={participant.botId}
                    data-comparison-bot={participant.botId}
                    className="space-y-3 rounded-lg border border-border bg-card p-4"
                  >
                    <h2 className="font-medium">{participant.name}</h2>
                    <ComparisonPin participant={participant} result={result} />
                    {result ? (
                      <>
                        <label
                          htmlFor={`compare-output-${result.runId}`}
                          className="flex items-center gap-2"
                        >
                          <Checkbox
                            id={`compare-output-${result.runId}`}
                            checked={selected.includes(result.runId)}
                            disabled={result.status !== "completed" || Boolean(comparison.merge)}
                            onCheckedChange={(checked) =>
                              setSelected((current) =>
                                checked
                                  ? [...current, result.runId]
                                  : current.filter((id) => id !== result.runId),
                              )
                            }
                          />
                          <Trans>Select output</Trans>
                        </label>
                        <ComparisonOutput result={result} />
                        {result.approvals.map(({ messageId, block }) =>
                          block.kind === "ask" ? (
                            <AskCard
                              key={messageId}
                              block={block}
                              canAnswer={result.status === "waiting-approval"}
                              onAnswer={async (answer) => {
                                await rpc.threads.answer({
                                  botId: comparison.coordinatorBotId,
                                  runId: result.runId,
                                  messageId,
                                  answer,
                                });
                                await refresh();
                              }}
                            />
                          ) : null,
                        )}
                      </>
                    ) : (
                      <Trans>Incomplete</Trans>
                    )}
                  </article>
                );
              })}
            </div>
            {!comparison.merge ? (
              <div className="flex flex-wrap items-center gap-3">
                <label htmlFor="compare-merge-bot">
                  <Trans>Merge with</Trans>
                  <NativeSelect
                    id="compare-merge-bot"
                    aria-label={t`Merge with`}
                    className="m-2 rounded border border-border bg-background p-2"
                    value={mergeBotId}
                    onChange={(event) => {
                      setMergeBotId(event.target.value);
                      setMergePreview(null);
                    }}
                  >
                    {bots.map((bot) => (
                      <NativeSelectOption key={bot.id} value={bot.id}>
                        {bot.name} · {bot.modelProvider} · {bot.modelId} · {bot.thinkingLevel}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
                {mergePreview ? <ComparisonPin participant={mergePreview} /> : null}
                {!comparison.budget.mergeReserved ? (
                  <span>
                    <Trans>1 run at this pin; hosted providers may bill per run</Trans>
                  </span>
                ) : null}
                <Button
                  disabled={busy || !selected.length}
                  onClick={() =>
                    void act(async () => {
                      if (!mergePreview) {
                        setMergePreview(
                          await rpc.comparisons.previewMerge({ id, botId: mergeBotId }),
                        );
                        return;
                      }
                      await rpc.comparisons.merge({
                        id,
                        botId: mergeBotId,
                        selectedRunIds: comparison.results
                          .filter((result) => selected.includes(result.runId))
                          .map((result) => result.runId),
                        reserveBudget: true,
                        expectedParticipant: mergePreview,
                      });
                      await refresh();
                    })
                  }
                >
                  {mergePreview ? <Trans>Merge selected</Trans> : <Trans>Preview merge</Trans>}
                </Button>
              </div>
            ) : (
              <article className="space-y-3 rounded-lg border border-border p-4">
                <h2>
                  <Trans>Merge</Trans>
                </h2>
                <ComparisonPin
                  participant={comparison.merge.participant}
                  result={comparison.merge.result}
                />
                <ComparisonOutput result={comparison.merge.result} />
                {comparison.merge.result.approvals.map(({ messageId, block }) =>
                  block.kind === "ask" ? (
                    <AskCard
                      key={messageId}
                      block={block}
                      canAnswer={comparison.merge!.result.status === "waiting-approval"}
                      onAnswer={async (answer) => {
                        await rpc.threads.answer({
                          botId: comparison.coordinatorBotId,
                          runId: comparison.merge!.result.runId,
                          messageId,
                          answer,
                        });
                        await refresh();
                      }}
                    />
                  ) : null,
                )}
              </article>
            )}
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const data = await rpc.export.comparison({ id });
                  downloadArtifactBytes(
                    `comparison-${id}.json`,
                    "application/json",
                    new TextEncoder().encode(JSON.stringify(data, null, 2)),
                  );
                })
              }
            >
              <Trans>Export JSON</Trans>
            </Button>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function ComparisonPin({
  participant,
  result,
}: {
  participant: ComparisonParticipant;
  result?: ComparisonResult;
}) {
  const { t } = useLingui();
  const { pin, computer } = participant.executing;
  return (
    <div className="text-sm text-muted-foreground">
      <p>
        {pin.provider} · {pin.modelId} ·{" "}
        {runtimeEffortLabel(pin, result?.provenance, t`requested`) ?? <Trans>Not reported</Trans>}
      </p>
      <details>
        <summary>{pin.runtimeKind}</summary>
        <p>
          {computer.kind} · {computer.id}
        </p>
      </details>
    </div>
  );
}
export function ComparisonOutput({ result }: { result: ComparisonResult }) {
  return (
    <>
      <p>
        {result.status === "waiting-approval" ? (
          <Trans>Waiting for approval</Trans>
        ) : result.status === "failed" ? (
          <Trans>Failed — {result.failure ?? "Not reported"}</Trans>
        ) : result.status === "completed" ? (
          <Trans>Completed</Trans>
        ) : result.status === "queued" ? (
          <Trans>Queued</Trans>
        ) : result.status === "running" ? (
          <Trans>Running</Trans>
        ) : result.status === "cancelled" ? (
          <Trans>Cancelled</Trans>
        ) : (
          <Trans>Incomplete</Trans>
        )}
      </p>
      <ChatMarkdown>{result.output}</ChatMarkdown>
      {result.citations.length ? (
        <ul>
          {result.citations.map((citation) => (
            <li key={citation}>
              <a href={citation} target="_blank" rel="noreferrer" className="break-all underline">
                {citation}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="grid grid-cols-2 gap-2 text-sm text-muted-foreground">
        <dt>
          <Trans>Reported model</Trans>
        </dt>
        <dd>{result.provenance.reportedModel ?? <Trans>Not reported</Trans>}</dd>
        <dt>
          <Trans>Model version</Trans>
        </dt>
        <dd>{result.provenance.reportedModelVersion ?? <Trans>Not reported</Trans>}</dd>
        <dt>
          <Trans>Duration</Trans>
        </dt>
        <dd>
          {result.durationMs === null ? (
            <Trans>Not reported</Trans>
          ) : (
            `${(result.durationMs / 1000).toFixed(1)} s`
          )}
        </dd>
        <dt>
          <Trans>Tokens</Trans>
        </dt>
        <dd>
          {result.usage.reported ? (
            `${result.usage.inputTokens} / ${result.usage.outputTokens}`
          ) : (
            <Trans>Not reported</Trans>
          )}
        </dd>
      </dl>
      {result.usage.costs.map((cost, index) => (
        <p key={`${index}:${cost.amount}`}>
          <Trans>Cost</Trans>: {cost.amount} · {cost.provenance}
        </p>
      ))}
      {result.provenance.memoryDiffered ? (
        <p>
          <Trans>Memory differed</Trans>
        </p>
      ) : null}
    </>
  );
}

export function ComparisonList() {
  const [rows, setRows] = useState<Comparison[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const rows = await rpc.comparisons.list({});
        if (active) {
          setRows(rows);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), TEAM_REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <div className="space-y-2">
      {error ? (
        <p role="alert">
          <Trans>Could not load comparisons; retry.</Trans>
        </p>
      ) : null}
      {rows.map((row) => (
        <Button key={row.id} variant="ghost" className="max-w-full" onClick={() => setId(row.id)}>
          <span className="truncate">{row.snapshot.text}</span> ·{" "}
          <Trans>Same task, {row.participants.length} bots</Trans>
        </Button>
      ))}
      {id ? <ComparePanel key={id} id={id} onClose={() => setId(null)} /> : null}
    </div>
  );
}
