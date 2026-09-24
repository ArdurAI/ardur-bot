import type { CuratorReport, SpaceLearningConfig } from "@ardurbot/contracts";
import { CuratorReportSchema } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { Button, Switch, Text, View } from "react-native";
import { rpc } from "./api";
import { useI18n } from "./i18n";
import { native } from "./native";

export function LearningCurator({
  settings,
  busy,
  change,
}: {
  settings: SpaceLearningConfig;
  busy: boolean;
  change: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<CuratorReport | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = () =>
      void rpc("learning/curator", {})
        .then((data) => {
          const reports = CuratorReportSchema.array().parse((data as { reports: unknown }).reports);
          if (active) {
            setLast(reports[0] ?? null);
            setError(false);
          }
        })
        .catch(() => {
          if (active) setError(true);
        });
    load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);
  return (
    <View>
      <Button title={t("Curator")} onPress={() => setOpen(!open)} />
      {open ? (
        <View>
          <Button
            title={t("Run now")}
            disabled={busy}
            onPress={() => void change(() => rpc("learning/curate", {}))}
          />
          <Text style={{ color: native.label }}>{t("Propose consolidation")}</Text>
          <Switch
            accessibilityLabel={t("Propose consolidation")}
            disabled={busy}
            value={settings.consolidationEnabled}
            onValueChange={(consolidationEnabled) =>
              void change(() =>
                rpc("learning/configure", {
                  enabled: settings.enabled,
                  consolidationEnabled,
                  reviewerPin: settings.reviewerPin ?? settings.destination,
                  budgets: settings.budgets,
                }),
              )
            }
          />
          <Text style={{ color: native.secondaryLabel }}>
            {settings.destination?.provider} · {settings.destination?.modelId} ·{" "}
            {settings.destination?.effort}
          </Text>
          <Text style={{ color: native.secondaryLabel }}>
            {t(
              "Consolidation uses the review connection and may incur model charges. Approval is required.",
            )}
          </Text>
          <Text style={{ color: native.label }}>{t("Last check")}</Text>
          {error ? (
            <Text style={{ color: native.label }}>{t("Could not load the last check.")}</Text>
          ) : last ? (
            <View>
              <Text style={{ color: native.label }}>
                {last.startedAt} · {last.status}
              </Text>
              <Text style={{ color: native.label }}>
                {t("Checked")}: {last.checked}; {t("Stale")}: {last.staleIds.length}; {t("Flags")}:{" "}
                {last.flaggedIds.length}; {t("Proposals")}: {last.proposalIds.length}
              </Text>
              <Text style={{ color: native.label }}>
                {last.durationMs} ms · {last.tokens ?? t("Unknown")} {t("tokens")}
              </Text>
              <Text selectable style={{ color: native.secondaryLabel }}>
                {[...last.staleIds, ...last.flaggedIds, ...last.proposalIds].join(", ")}
              </Text>
            </View>
          ) : (
            <Text style={{ color: native.label }}>{t("No checks yet.")}</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}
