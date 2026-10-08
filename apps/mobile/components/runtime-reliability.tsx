import type { RuntimeReliability as Reliability } from "@ardurbot/contracts";
import { runtimeNames } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { failureCategoryText } from "../lib/failure-categories";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function RuntimeReliability() {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<Reliability | null>(null);
  useEffect(() => {
    setReport(null);
    if (!open) return;
    let active = true;
    let loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      void rpc<Reliability>("runtimes/reliability")
        .then((value) => {
          if (active) setReport(value);
        })
        .catch(() => {
          if (active) setReport(null);
        })
        .finally(() => {
          loading = false;
        });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);
  const secondary = { color: tokens.mutedForeground };
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <Text style={{ color: tokens.foreground }}>{t("Last 7 days")}</Text>
      </Pressable>
      {open ? (
        report ? (
          report.runtimes.map((row) => (
            <View key={row.runtimeKind} style={{ gap: 4 }}>
              <Text style={{ color: tokens.foreground }}>{runtimeNames[row.runtimeKind]}</Text>
              {row.completed + row.failed + row.cancelled === 0 ? (
                <Text style={secondary}>{t("No runs yet")}</Text>
              ) : (
                <>
                  <Text style={secondary}>
                    {t("Completed")}: {row.completed} · {t("Failed")}: {row.failed} ·{" "}
                    {t("Cancelled")}: {row.cancelled}
                  </Text>
                  <Text style={secondary}>
                    {t("Success")}:{" "}
                    {row.successRate === null
                      ? t("Not measured")
                      : new Intl.NumberFormat(dateLocaleForUi(locale), {
                          style: "percent",
                          maximumFractionDigits: 0,
                        }).format(row.successRate)}
                  </Text>
                  <Text style={secondary}>
                    {t("First reply")}:{" "}
                    {row.firstReplyMedianMs === null
                      ? t("Not measured")
                      : new Intl.NumberFormat(dateLocaleForUi(locale), {
                          style: "unit",
                          unit: "second",
                          maximumFractionDigits: 1,
                        }).format(row.firstReplyMedianMs / 1000)}
                  </Text>
                  <Text style={secondary}>
                    {t("{count} measured runs", { count: row.measuredRuns })}
                  </Text>
                  {row.lastFailure ? (
                    <Text style={secondary}>
                      {t("Last failure")}:{" "}
                      {failureCategoryText(row.lastFailure.category, {
                        runtime: runtimeNames[row.runtimeKind],
                      })}
                    </Text>
                  ) : null}
                </>
              )}
            </View>
          ))
        ) : (
          <Text style={secondary}>{t("Not measured")}</Text>
        )
      ) : null}
    </View>
  );
}
