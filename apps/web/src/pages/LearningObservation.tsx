import type { LearningObservation } from "@ardurbot/contracts";
import { learningObservationUnmeasured } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

export function LearningObservationView({ observation: o }: { observation: LearningObservation }) {
  const after = o.correctionsAfter.feedback + o.correctionsAfter.steering;
  const before = o.before.corrections.feedback + o.before.corrections.steering;
  return (
    <div className="space-y-2 text-xs" data-testid="learning-observations">
      <p>
        <Trans>
          {after} corrections in {o.exposedRuns} exposed runs; before: {before} in {o.before.runs}{" "}
          comparable runs
        </Trans>
      </p>
      {learningObservationUnmeasured(o) ? (
        <p>
          <Trans>Not enough runs to tell</Trans>
        </p>
      ) : null}
      <p>
        <Trans>Window</Trans>: {o.window.from} – {o.window.to}
      </p>
      <p>
        <Trans>Before</Trans>: {o.before.window.from} – {o.before.window.to}
      </p>
      <details>
        <summary>
          <Trans>Measurement details</Trans>
        </summary>
        <p>
          <Trans>Feedback corrections</Trans>: {o.correctionsAfter.feedback} / {o.exposedRuns};{" "}
          <Trans>Before</Trans>: {o.before.corrections.feedback} / {o.before.runs}
        </p>
        <p>
          <Trans>Steering corrections</Trans>: {o.correctionsAfter.steering} / {o.exposedRuns};{" "}
          <Trans>Before</Trans>: {o.before.corrections.steering} / {o.before.runs}
        </p>
        <p>
          <Trans>Denials</Trans>: {o.denialsAfter.inappropriate} <Trans>inappropriate</Trans>,{" "}
          {o.denialsAfter.safety} <Trans>safety</Trans>, {o.denialsAfter.unknown}{" "}
          <Trans>unclassified</Trans> / {o.exposedRuns}
        </p>
        <p>
          <Trans>Failures</Trans>: {o.failuresAfter.task} <Trans>task</Trans>,{" "}
          {o.failuresAfter.integration} <Trans>integration</Trans>, {o.failuresAfter.provider}{" "}
          <Trans>provider</Trans>, {o.failuresAfter.pin} <Trans>pin</Trans>,{" "}
          {o.failuresAfter.unknown} <Trans>unclassified</Trans> / {o.exposedRuns}
        </p>
        <p>
          <Trans>Cancellations</Trans>: {o.cancellationsAfter} / {o.exposedRuns}
        </p>
        <p>
          <Trans>Acceptance</Trans>: {o.acceptance.accepted} / {o.acceptance.evaluated};{" "}
          <Trans>Task contracts</Trans>: {o.acceptance.contracts} / {o.exposedRuns}
        </p>
        <p>
          <Trans>Mean elapsed time (ms)</Trans>: {o.timeTokensDelta.timeMs.afterMean ?? "—"} (
          {o.timeTokensDelta.timeMs.afterSamples}); <Trans>Before</Trans>:{" "}
          {o.timeTokensDelta.timeMs.beforeMean ?? "—"} ({o.timeTokensDelta.timeMs.beforeSamples});{" "}
          <Trans>Delta</Trans>: {o.timeTokensDelta.timeMs.delta ?? "—"}
        </p>
        <p>
          <Trans>Mean tokens</Trans>: {o.timeTokensDelta.tokens.afterMean ?? "—"} (
          {o.timeTokensDelta.tokens.afterSamples}); <Trans>Before</Trans>:{" "}
          {o.timeTokensDelta.tokens.beforeMean ?? "—"} ({o.timeTokensDelta.tokens.beforeSamples});{" "}
          <Trans>Delta</Trans>: {o.timeTokensDelta.tokens.delta ?? "—"}
        </p>
      </details>
      <ul className="list-disc pl-4 text-muted-foreground">
        {o.missing
          .filter((s) => s !== "Not enough runs to tell")
          .map((s) => (
            <li key={s}>{s}</li>
          ))}
      </ul>
    </div>
  );
}
export function LearningObservations({
  documentId,
  revision,
}: {
  documentId: string;
  revision: number;
}) {
  const [observation, setObservation] = useState<LearningObservation | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setObservation(null);
    setError(false);
    void rpc.learning
      .observation({ documentId, revision })
      .then((value) => {
        if (active) setObservation(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [documentId, revision, attempt]);
  if (error)
    return (
      <div role="alert">
        <Trans>Could not load observations.</Trans>
        <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    );
  return observation ? (
    <LearningObservationView observation={observation} />
  ) : (
    <p className="text-xs">
      <Trans>Loading observations…</Trans>
    </p>
  );
}
