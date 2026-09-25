import type { ConnectionOverview, UsagePeriod, UsageSummary } from "@ardurbot/contracts";
import { BoardFilingOutcomeCountSchema, BoardWorkSchema } from "@ardurbot/contracts/board";
import type { OverviewNow } from "@ardurbot/core";
import { activeDelegations, TEAM_REFRESH_MS } from "@ardurbot/core";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { lazy, Suspense, useCallback, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Button,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { filingDestination } from "../lib/filing-destination";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { loadOverviewConnections, loadOverviewNow, loadOverviewUsage } from "../lib/overview";

const loadWork = async () => {
  const [work, outcomes] = await Promise.all([
    rpc("board/work", {}),
    // A server without filing outcomes still shows the Work summary.
    rpc("board/filingOutcomes", {}).catch(() => null),
  ]);
  const filingOutcomes = BoardFilingOutcomeCountSchema.array().safeParse(
    (outcomes as { bots?: unknown } | null)?.bots,
  );
  return {
    ...BoardWorkSchema.parse(work),
    filingOutcomes: filingOutcomes.success ? filingOutcomes.data : [],
  };
};
const MobileBoard = lazy(() =>
  import("../components/board-view").then((module) => ({ default: module.MobileBoard })),
);
export default function OverviewScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const params = useLocalSearchParams<{ view?: string }>();
  const router = useRouter();
  const board = params.view === "board";
  return (
    <View style={{ flex: 1, backgroundColor: tokens.background }}>
      <Stack.Screen options={{ title: board ? t("Board") : t("Dashboard") }} />
      <View style={{ flexDirection: "row", paddingHorizontal: 16 }}>
        <Button
          title={t("Overview")}
          disabled={!board}
          onPress={() => router.setParams({ view: "overview", item: "" })}
        />
        <Button
          title={t("Board")}
          disabled={board}
          onPress={() => router.setParams({ view: "board" })}
        />
      </View>
      {board ? (
        <Suspense fallback={<ActivityIndicator />}>
          <MobileBoard />
        </Suspense>
      ) : (
        <ScrollView contentContainerStyle={styles.page}>
          <OverviewPanel title={t("Now")} load={loadOverviewNow}>
            {(data) => <Now data={data} />}
          </OverviewPanel>
          <OverviewPanel title={t("Work")} load={loadWork}>
            {(data) => (
              <View style={styles.lines}>
                <Line>
                  {t("Ready")}: {data.ready} · {t("In progress")}: {data.inProgress} ·{" "}
                  {t("Blocked")}: {data.blocked}
                </Line>
                {data.items.map((item) => (
                  <View key={item.id}>
                    <Button
                      title={item.title}
                      onPress={() =>
                        router.setParams({
                          view: "board",
                          workspace: data.workspace?.id,
                          item: item.id,
                        })
                      }
                    />
                    {item.filedBy ? (
                      <Pressable
                        accessibilityRole="link"
                        onPress={() => {
                          if (item.filedBy) router.push(filingDestination(item.filedBy));
                        }}
                      >
                        <Text style={{ color: tokens.foreground }}>
                          {t("Filed by {name}", { name: item.filedBy.botName })}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                ))}
                {data.filingOutcomes.map((row) => (
                  <Line key={row.botId}>
                    {t(
                      "{name} filed {filed}: {done} done, {open} open, {other} closed otherwise.",
                      row,
                    )}
                  </Line>
                ))}
                {!data.workspace ? (
                  <Button
                    title={t("Set up a board")}
                    onPress={() => router.push("/boards-settings")}
                  />
                ) : null}
              </View>
            )}
          </OverviewPanel>
          <Button title={t("Team")} onPress={() => router.push("/team")} />
          <OverviewPanel title={t("Connections")} load={loadOverviewConnections}>
            {(data) => <Connections data={data} />}
          </OverviewPanel>
          <OverviewPanel title={t("Usage")} load={loadOverviewUsage}>
            {(data) => <Usage data={data} />}
          </OverviewPanel>
        </ScrollView>
      )}
    </View>
  );
}
function OverviewPanel<T>({
  title,
  load,
  children,
}: {
  title: string;
  load: () => Promise<T>;
  children: (data: T) => ReactNode;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      let pending = false;
      const refresh = async () => {
        if (
          pending ||
          AppState.currentState === "background" ||
          AppState.currentState === "inactive"
        )
          return;
        pending = true;
        try {
          const next = await load();
          if (active) {
            setData(next);
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
    }, [load, retry]),
  );
  return (
    <View style={[styles.panel, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <Text accessibilityRole="header" style={[styles.heading, { color: tokens.foreground }]}>
        {title}
      </Text>
      {data === undefined && !error ? <ActivityIndicator accessibilityLabel={title} /> : null}
      {error ? (
        <View>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {t("Could not load")}
          </Text>
          <Button title={t("Retry")} onPress={() => setRetry((value) => value + 1)} />
        </View>
      ) : null}
      {data === undefined ? null : children(data)}
    </View>
  );
}
function Line({ children }: { children: ReactNode }) {
  const tokens = useMobileTokens();
  return <Text style={{ color: tokens.foreground }}>{children}</Text>;
}
function Now({ data }: { data: OverviewNow }) {
  const { t } = useI18n();
  const delegations = activeDelegations(data.rows);
  return (
    <View style={styles.lines}>
      {!data.runs.length && !delegations.length ? <Line>{t("Nothing running")}</Line> : null}
      {data.runs.map((run) => (
        <View key={run.runId} style={styles.lines}>
          <Line>{run.botName}</Line>
          <Line>{run.promptSnippet}</Line>
          {run.status === "waiting_input" &&
          !data.approvals.some((approval) => approval.runId === run.runId) ? (
            <Line>{t("Waiting for input")}</Line>
          ) : null}
          {data.approvals
            .filter((approval) => approval.runId === run.runId)
            .map((approval, index) =>
              approval.block.kind === "ask" ? (
                <View key={`${approval.messageId}:${index}`} style={styles.lines}>
                  <Line>{t("Waiting for your approval")}</Line>
                  <Line>{approval.block.text}</Line>
                </View>
              ) : null,
            )}
        </View>
      ))}
      {delegations.map((row) => (
        <Line key={row.id}>
          {row.card?.goal ?? row.rootTaskId}
          {" · "}
          {row.actingName}
          {" · "}
          {row.status === "queued"
            ? t("Queued")
            : row.status === "cancel-requested"
              ? t("Stopping")
              : t("Working")}
        </Line>
      ))}
    </View>
  );
}
function Connections({ data }: { data: ConnectionOverview[] }) {
  const { t } = useI18n();
  const states = {
    connected: t("Connected"),
    "needs-sign-in": t("Needs sign-in"),
    "not-connected": t("Not connected"),
    error: t("Error"),
  };
  return (
    <View style={styles.lines}>
      {!data.length ? <Line>{t("No connections")}</Line> : null}
      {data.map((row) => (
        <Line key={`${row.kind}:${row.id}`}>
          {row.name}
          {" · "}
          {states[row.state]}
        </Line>
      ))}
    </View>
  );
}
function Usage({ data }: { data: UsageSummary }) {
  const { t } = useI18n();
  return (
    <View style={styles.lines}>
      {!data.providers.length ? <Line>{t("No usage")}</Line> : null}
      {data.providers.map((provider) => (
        <View key={provider.provider} style={styles.lines}>
          <Line>{provider.provider}</Line>
          <Line>{t("Today (UTC)")}</Line>
          <Period value={provider.today} />
          <Line>{t("This week (UTC)")}</Line>
          <Period value={provider.week} />
        </View>
      ))}
    </View>
  );
}
function Period({ value }: { value: UsagePeriod }) {
  const { t } = useI18n();
  return (
    <Line>
      {t("{records} usage records", { records: value.records })}
      {" · "}
      {t("{tokens} tokens", { tokens: value.inputTokens + value.outputTokens })}
      {value.cost === null
        ? null
        : ` · ${t("Cost")}: ${value.cost.toLocaleString(undefined, { maximumFractionDigits: 6 })}`}
    </Line>
  );
}
const styles = StyleSheet.create({
  page: { padding: 16, gap: 16 },
  panel: { borderWidth: 1, borderRadius: 12, padding: 16, gap: 12 },
  heading: { fontSize: 17, fontWeight: "600" },
  lines: { gap: 8 },
});
