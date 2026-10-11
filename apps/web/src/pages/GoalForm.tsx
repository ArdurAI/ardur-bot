import { GOAL_DEFAULT_TOKEN_LIMIT } from "@ardurbot/contracts";
import { Button, Input, Textarea } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { FeatureDocsLink } from "../components/FeatureDocsLink";

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
    boardWorkspaceId?: string;
    boardItemId?: string;
  }) => Promise<void>;
}) {
  const { t } = useLingui();
  const objectiveId = useId();
  const doneWhenId = useId();
  const untilId = useId();
  const tokensId = useId();
  const boardItemId = useId();
  const boardWorkspaceId = useId();
  const [objective, setObjective] = useState("");
  const [doneWhen, setDoneWhen] = useState("");
  const [until, setUntil] = useState("");
  const [tokens, setTokens] = useState(GOAL_DEFAULT_TOKEN_LIMIT);
  const [itemId, setItemId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
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
        ...(itemId.trim() && workspaceId.trim()
          ? { boardWorkspaceId: workspaceId.trim(), boardItemId: itemId.trim() }
          : {}),
      });
    } catch (error) {
      setError(
        error instanceof Error && error.message === "Could not link that board item."
          ? t`Could not link that board item.`
          : t`Could not start goal. Check the deadline and try again.`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-5 space-y-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3 text-sm font-medium">
        <Trans>Start goal</Trans>
        <FeatureDocsLink featureId="group-goals" title={t`Start goal`} step="fill-goal-form" />
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
      <label htmlFor={boardItemId} className="block text-sm text-muted-foreground">
        <Trans>Board item</Trans>
        <Input
          id={boardItemId}
          className="mt-1"
          value={itemId}
          onChange={(event) => setItemId(event.target.value)}
        />
      </label>
      <label htmlFor={boardWorkspaceId} className="block text-sm text-muted-foreground">
        <Trans>Board</Trans>
        <Input
          id={boardWorkspaceId}
          className="mt-1"
          value={workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
        />
      </label>
      <Button
        className="w-full"
        disabled={
          submitting ||
          !objective.trim() ||
          doneWhen.split("\n").filter(Boolean).length > 10 ||
          tokens < 1 ||
          tokens > 5000000 ||
          Boolean(itemId.trim()) !== Boolean(workspaceId.trim())
        }
        onClick={() => void start()}
      >
        {submitting ? <Trans>Starting…</Trans> : <Trans>Start goal</Trans>}
      </Button>
    </div>
  );
}
