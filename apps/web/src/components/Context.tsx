import type { Brief, ContextAggregate, Run } from "@ardurbot/contracts";
import { Button, Input, Popover, PopoverContent, PopoverTrigger, Textarea } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";

const duration = (value: number | null | undefined) =>
  value == null ? "—" : `${Math.round(value)} ms`;
export function ContextMetrics({ value }: { value?: ContextAggregate }) {
  return (
    <dl className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
      <dt>
        <Trans>Time to first token</Trans> (p50 / p95)
      </dt>
      <dd>
        {duration(value?.timeToFirstTokenP50Ms)} / {duration(value?.timeToFirstTokenP95Ms)}
      </dd>
      <dt>
        <Trans>Context</Trans>
      </dt>
      <dd>{value?.averagePromptCharacters ?? "—"}</dd>
      <dt>
        <Trans>Cache hits</Trans>
      </dt>
      <dd>{value?.cacheHitRatio == null ? "—" : `${Math.round(value.cacheHitRatio * 100)}%`}</dd>
      <dt>
        <Trans>Queue wait</Trans> (p50 / p95)
      </dt>
      <dd>
        {duration(value?.queueWaitP50Ms)} / {duration(value?.queueWaitP95Ms)}
      </dd>
    </dl>
  );
}
export function RunContext({ run }: { run?: Pick<Run, "contextSnapshot" | "routingRule"> | null }) {
  const snapshot = run?.contextSnapshot;
  if (!snapshot && run?.routingRule !== "default") return null;
  return (
    <Popover>
      <PopoverTrigger className="app-no-drag cursor-pointer text-xs text-muted-foreground">
        <Trans>Context</Trans>
      </PopoverTrigger>
      <PopoverContent align="start" data-testid="run-context" className="space-y-3 text-xs">
        {run?.routingRule === "default" ? (
          <p>
            <Trans>Routed by default</Trans>
          </p>
        ) : null}
        {snapshot ? (
          <dl className="grid grid-cols-2 gap-2">
            <dt>
              <Trans>Time to first token</Trans>
            </dt>
            <dd>{duration(snapshot.timeToFirstTokenMs)}</dd>
            <dt>
              <Trans>Context</Trans>
            </dt>
            <dd>{Object.values(snapshot.layers).reduce((sum, size) => sum + size, 0)}</dd>
            <dt>
              <Trans>Cache hits</Trans>
            </dt>
            <dd>{snapshot.cachedTokens ?? "—"}</dd>
            <dt>
              <Trans>Queue wait</Trans>
            </dt>
            <dd>{duration(snapshot.queueWaitMs)}</dd>
          </dl>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
export function BriefDocument({ brief, saved }: { brief: Brief; saved: () => void }) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(brief.content);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const label = brief.groupId ? (brief.groupName ?? t`Group brief`) : t`Brief`;
  const time = brief.rewrittenAt ? new Date(brief.rewrittenAt).toLocaleString() : "";
  const reason =
    brief.reason === "Task budget reached"
      ? t`Task budget reached`
      : brief.reason === "Model unavailable"
        ? t`Model unavailable`
        : brief.reason === "Model or memory unavailable"
          ? t`Model or memory unavailable`
          : brief.reason === "Owner edited recently"
            ? t`Owner edited recently`
            : brief.reason;
  async function save() {
    setPending(true);
    setError(false);
    try {
      await rpc.briefs.update({
        botId: brief.botId,
        groupId: brief.groupId,
        content,
        expectedRevision: brief.revision,
      });
      setEditing(false);
      saved();
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer">{label}</summary>
      {editing ? (
        <Textarea
          aria-label={label}
          value={content}
          maxLength={6000}
          rows={14}
          onChange={(event) => setContent(event.target.value)}
        />
      ) : (
        <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs">
          {brief.content}
        </pre>
      )}
      {time ? (
        <p className="mt-2 text-xs text-muted-foreground">
          <Trans>Rewritten {time}</Trans>
        </p>
      ) : null}
      {reason ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Left unchanged: {reason}</Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          <Trans>Could not save changes</Trans>
        </p>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => (editing ? void save() : (setContent(brief.content), setEditing(true)))}
      >
        {editing ? <Trans>Save</Trans> : <Trans>Edit</Trans>}
      </Button>
      {editing ? (
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          <Trans>Cancel</Trans>
        </Button>
      ) : null}
    </details>
  );
}
export function BotContext({
  botId,
  groupId,
  label,
  showSettings = true,
}: {
  botId: string;
  groupId?: string;
  label?: string;
  showSettings?: boolean;
}) {
  const { t } = useLingui();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [metrics, setMetrics] = useState<Awaited<ReturnType<typeof rpc.metrics.context>> | null>(
    null,
  );
  const [concurrentRuns, setConcurrentRuns] = useState(3);
  const [error, setError] = useState(false);
  const [period, setPeriod] = useState<"today" | "sevenDays">("today");
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError(false);
    setBriefs([]);
    setMetrics(null);
    Promise.all([
      rpc.briefs.list({ botId, groupId }),
      rpc.metrics.context({ botId, groupId }),
      rpc.context.settings({ botId }),
    ])
      .then(([briefs, metrics, settings]) => {
        if (!active) return;
        setBriefs(briefs);
        setMetrics(metrics);
        setConcurrentRuns(settings.concurrentRuns);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [botId, groupId, open, version]);
  return (
    <details
      className="mt-5 border-t border-border pt-4"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm">{label ?? <Trans>Context</Trans>}</summary>
      <div className="mt-3 space-y-3">
        {error ? (
          <div role="alert">
            <Trans>Could not load data</Trans>{" "}
            <Button size="sm" variant="ghost" onClick={() => setVersion((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button
            size="xs"
            variant="ghost"
            aria-pressed={period === "today"}
            onClick={() => setPeriod("today")}
          >
            <Trans>Today</Trans>
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-pressed={period === "sevenDays"}
            onClick={() => setPeriod("sevenDays")}
          >
            <Trans>7 days</Trans>
          </Button>
        </div>
        <ContextMetrics
          value={metrics?.[period].find((row) => row.groupId === (groupId ?? null))}
        />
        {showSettings ? (
          <label htmlFor={inputId} className="block text-sm">
            <Trans>Concurrent runs</Trans>
            <Input
              id={inputId}
              aria-label={t`Concurrent runs`}
              type="number"
              min={1}
              max={16}
              value={concurrentRuns}
              onChange={(event) => setConcurrentRuns(Number(event.target.value))}
              onBlur={() => {
                if (Number.isInteger(concurrentRuns) && concurrentRuns >= 1 && concurrentRuns <= 16)
                  void rpc.bots.update({ botId, concurrentRuns }).catch(() => setError(true));
              }}
            />
          </label>
        ) : null}
        {briefs.map((brief) => (
          <BriefDocument
            key={brief.threadId}
            brief={brief}
            saved={() => setVersion((value) => value + 1)}
          />
        ))}
      </div>
    </details>
  );
}
