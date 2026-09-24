import type { LearningObservation } from "@ardurbot/contracts";
import {
  LearningObservationSchema,
  learningObservationSummary,
  learningObservationUnmeasured,
} from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { Button, Text, View } from "react-native";
import { rpc } from "./api";
import { useI18n } from "./i18n";
import { native } from "./native";

export function LearningObservations({
  documentId,
  revision,
}: {
  documentId: string;
  revision: number;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState<LearningObservation | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setValue(null);
    setError(false);
    void rpc("learning/observation", { documentId, revision })
      .then((v) => {
        if (active) setValue(LearningObservationSchema.parse(v));
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [documentId, revision, retry]);
  if (error)
    return (
      <View>
        <Text style={{ color: native.label }} accessibilityRole="alert">
          {t("Could not load observations.")}
        </Text>
        <Button title={t("Retry")} onPress={() => setRetry((n) => n + 1)} />
      </View>
    );
  if (!value) return <Text style={{ color: native.label }}>{t("Loading observations…")}</Text>;
  return <LearningObservationView observation={value} />;
}
export function LearningObservationView({
  observation: value,
}: {
  observation: LearningObservation;
}) {
  const { t } = useI18n();
  return (
    <View>
      <Text style={{ color: native.label }}>{learningObservationSummary(value)}</Text>
      {learningObservationUnmeasured(value) ? (
        <Text style={{ color: native.label }}>{t("Not enough runs to tell")}</Text>
      ) : null}
      <Text style={{ color: native.label }}>
        {t("Window")}: {value.window.from} – {value.window.to}
      </Text>
      <Text style={{ color: native.label }}>
        {t("Before")}: {value.before.window.from} – {value.before.window.to}
      </Text>
      <Text style={{ color: native.label }}>
        {t("Feedback corrections")}: {value.correctionsAfter.feedback}/{value.exposedRuns};{" "}
        {t("Before")}: {value.before.corrections.feedback}/{value.before.runs}
      </Text>
      <Text style={{ color: native.label }}>
        {t("Steering corrections")}: {value.correctionsAfter.steering}/{value.exposedRuns};{" "}
        {t("Before")}: {value.before.corrections.steering}/{value.before.runs}
      </Text>
      <Text style={{ color: native.label }}>
        {t("Failures")}:{" "}
        {Object.entries(value.failuresAfter)
          .map(([kind, count]) => `${t(kind)} ${count}/${value.exposedRuns}`)
          .join("; ")}
      </Text>
      <Text style={{ color: native.label }}>
        {t("Denials")}:{" "}
        {Object.entries(value.denialsAfter)
          .map(([kind, count]) => `${t(kind)} ${count}/${value.exposedRuns}`)
          .join("; ")}
      </Text>
      <Text style={{ color: native.label }}>
        {t("Cancellations")}: {value.cancellationsAfter}/{value.exposedRuns}
      </Text>
      <Text style={{ color: native.label }}>
        {t("Acceptance")}: {value.acceptance.accepted}/{value.acceptance.evaluated};{" "}
        {t("Task contracts")}: {value.acceptance.contracts}/{value.exposedRuns}
      </Text>
      <Text style={{ color: native.label }}>
        {t("Mean tokens")}: {value.timeTokensDelta.tokens.afterMean ?? "—"} (
        {value.timeTokensDelta.tokens.afterSamples}); {t("Before")}:{" "}
        {value.timeTokensDelta.tokens.beforeMean ?? "—"} (
        {value.timeTokensDelta.tokens.beforeSamples}); {t("Delta")}:{" "}
        {value.timeTokensDelta.tokens.delta ?? "—"}
      </Text>
      <Text style={{ color: native.label }}>
        {t("Mean elapsed time (ms)")}: {value.timeTokensDelta.timeMs.afterMean ?? "—"} (
        {value.timeTokensDelta.timeMs.afterSamples}); {t("Before")}:{" "}
        {value.timeTokensDelta.timeMs.beforeMean ?? "—"} (
        {value.timeTokensDelta.timeMs.beforeSamples}); {t("Delta")}:{" "}
        {value.timeTokensDelta.timeMs.delta ?? "—"}
      </Text>
      {value.missing
        .filter((s) => s !== "Not enough runs to tell")
        .map((s) => (
          <Text style={{ color: native.secondaryLabel }} key={s}>
            {t(s)}
          </Text>
        ))}
    </View>
  );
}
