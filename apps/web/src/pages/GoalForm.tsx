import { GOAL_DEFAULT_TOKEN_LIMIT } from "@ardurbot/contracts";
import { Button, Input, Textarea } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

export function StartGoalForm({
  groupId,
  onStart,
}: {
  groupId: string;
  onStart: (input: {
    groupId: string;
    objective: string;
    doneWhen: string[];
    untilAt?: string;
    tokenLimit: number;
  }) => Promise<void>;
}) {
  const { t } = useLingui();
  const objectiveId = useId();
  const doneWhenId = useId();
  const untilId = useId();
  const tokensId = useId();
  const [objective, setObjective] = useState("");
  const [doneWhen, setDoneWhen] = useState("");
  const [until, setUntil] = useState("");
  const [tokens, setTokens] = useState(GOAL_DEFAULT_TOKEN_LIMIT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!objective.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onStart({
        groupId,
        objective: objective.trim(),
        doneWhen: doneWhen
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        untilAt: until ? new Date(until).toISOString() : undefined,
        tokenLimit: tokens,
      });
    } catch {
      setError(t`Could not start goal. Check the deadline and try again.`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-5 space-y-3 border-t border-border pt-4">
      <div className="text-sm font-medium">
        <Trans>Start goal</Trans>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <label htmlFor={objectiveId} className="block text-sm text-muted-foreground">
        <Trans>Objective</Trans>
        <Input
          id={objectiveId}
          className="mt-1"
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
        />
      </label>
      <label htmlFor={doneWhenId} className="block text-sm text-muted-foreground">
        <Trans>Done when (one per line)</Trans>
        <Textarea
          id={doneWhenId}
          className="mt-1"
          value={doneWhen}
          onChange={(event) => setDoneWhen(event.target.value)}
          rows={3}
        />
      </label>
      <label htmlFor={untilId} className="block text-sm text-muted-foreground">
        <Trans>Until (defaults to eight hours)</Trans>
        <Input
          id={untilId}
          className="mt-1"
          type="datetime-local"
          value={until}
          onChange={(event) => setUntil(event.target.value)}
        />
      </label>
      <label htmlFor={tokensId} className="block text-sm text-muted-foreground">
        <Trans>Token limit</Trans>
        <Input
          id={tokensId}
          className="mt-1"
          type="number"
          min={1}
          max={5000000}
          value={tokens}
          onChange={(event) => setTokens(Number(event.target.value))}
        />
      </label>
      <Button
        className="w-full"
        disabled={
          submitting ||
          !objective.trim() ||
          doneWhen.split("\n").filter(Boolean).length > 10 ||
          tokens < 1 ||
          tokens > 5000000
        }
        onClick={() => void start()}
      >
        {submitting ? <Trans>Starting…</Trans> : <Trans>Start goal</Trans>}
      </Button>
    </div>
  );
}
