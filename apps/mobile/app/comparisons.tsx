import type { Comparison, ComparisonParticipant, ComparisonResult } from "@ardurbot/contracts";
import { runtimeNames } from "@ardurbot/contracts";
import {
  comparisonStatusText,
  formatModelPin,
  runtimeEffortLabel,
  TEAM_REFRESH_MS,
} from "@ardurbot/core";
import { Stack, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Button,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { loadComparisons } from "../lib/comparisons";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export default function ComparisonsScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [rows, setRows] = useState<Comparison[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const { width } = useWindowDimensions();
  useFocusEffect(
    useCallback(() => {
      let active = true;
      let pending = false;
      const refresh = async () => {
        if (pending) return;
        pending = true;
        try {
          const next = await loadComparisons();
          if (active) {
            setRows(next);
            setLoaded(true);
            setError(false);
          }
        } catch {
          if (active) setError(true);
        } finally {
          pending = false;
        }
      };
      void refresh();
      const timer = setInterval(() => void refresh(), TEAM_REFRESH_MS);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [retry]),
  );
  const comparison = rows.find((item) => item.id === selected);
  return (
    <View style={[styles.page, { backgroundColor: tokens.background }]}>
      <Stack.Screen options={{ title: t("Comparisons") }} />
      {!loaded && !error ? <ActivityIndicator /> : null}
      {error ? (
        <Button
          title={t("Could not load comparisons; retry.")}
          onPress={() => setRetry((value) => value + 1)}
        />
      ) : null}
      {comparison ? (
        <>
          <Button title={t("Back")} onPress={() => setSelected(null)} />
          <Text style={{ color: tokens.foreground }}>
            {t("Same task")}, {comparison.participants.length} {t("bots")}
          </Text>
          <Text numberOfLines={3} style={{ color: tokens.foreground }}>
            {comparison.snapshot.text}
          </Text>
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator
            accessibilityLabel={t("Comparison results")}
          >
            {comparison.participants.map((participant) => (
              <ScrollView key={participant.botId} style={{ width: width - 32 }}>
                <MobileComparisonOutput
                  participant={participant}
                  result={comparison.results.find((item) => item.botId === participant.botId)}
                />
              </ScrollView>
            ))}
            {comparison.merge ? (
              <ScrollView style={{ width: width - 32 }}>
                <Text style={{ color: tokens.foreground }}>{t("Merge")}</Text>
                <MobileComparisonOutput
                  participant={comparison.merge.participant}
                  result={comparison.merge.result}
                />
              </ScrollView>
            ) : null}
          </ScrollView>
        </>
      ) : (
        <ScrollView>
          {rows.map((row) => (
            <Button
              key={row.id}
              title={`${row.snapshot.text} · ${row.participants.length} ${t("bots")}`}
              onPress={() => setSelected(row.id)}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}
export function MobileComparisonOutput({
  participant,
  result,
}: {
  participant: ComparisonParticipant;
  result?: ComparisonResult;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const pin = participant.executing.pin;
  const text = { color: tokens.foreground };
  return (
    <View style={[styles.result, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <Text style={[text, styles.name]}>{participant.name}</Text>
      <Text style={text}>
        {formatModelPin(pin, runtimeEffortLabel(pin, result?.provenance, t("requested"))) ||
          t("Not reported")}
      </Text>
      <Text style={text}>
        {runtimeNames[pin.runtimeKind]} · {participant.executing.computer.kind}
      </Text>
      <Text style={text}>{result ? comparisonStatusText(result, t) : t("Incomplete")}</Text>
      {result ? (
        <>
          <Text selectable style={text}>
            {result.output}
          </Text>
          {result.citations.map((citation) => (
            <Text selectable key={citation} style={text}>
              {citation}
            </Text>
          ))}
          <Text style={text}>
            {t("Reported model")}: {result.provenance.reportedModel ?? t("Not reported")}
          </Text>
          <Text style={text}>
            {t("Model version")}: {result.provenance.reportedModelVersion ?? t("Not reported")}
          </Text>
          <Text style={text}>
            {t("Duration")}:{" "}
            {result.durationMs === null
              ? t("Not reported")
              : `${(result.durationMs / 1000).toFixed(1)} s`}
          </Text>
          <Text style={text}>
            {t("Tokens")}:{" "}
            {result.usage.reported
              ? `${result.usage.inputTokens} / ${result.usage.outputTokens}`
              : t("Not reported")}
          </Text>
          {result.usage.costs.map((cost, index) => (
            <Text key={`${index}:${cost.amount}`} style={text}>
              {t("Cost")}: {cost.amount} · {cost.provenance}
            </Text>
          ))}
          {result.approvals.map(({ messageId, block }) =>
            block.kind === "ask" ? (
              <Text key={messageId} style={text}>
                {block.text}
              </Text>
            ) : null,
          )}
          {result.provenance.memoryDiffered ? (
            <Text style={text}>{t("Memory differed")}</Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, padding: 16, gap: 8 },
  result: { padding: 16, gap: 12, borderWidth: 1, borderRadius: 12 },
  name: { fontSize: 17, fontWeight: "600" },
});
