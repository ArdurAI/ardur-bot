import type { HostLabel, TeamRow } from "@ardurbot/contracts";
import { runtimeEffortLabel, TEAM_REFRESH_MS, teamDeliveryText } from "@ardurbot/core";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Button, FlatList, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { acceptTeamTask, loadTeamRows, mobileTeamRow, stopTeamTask } from "../lib/team";

export default function TeamScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [rows, setRows] = useState<TeamRow[]>([]);
  const [hostLabel, setHostLabel] = useState<HostLabel>();
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      let pending = false;
      const refresh = async () => {
        if (pending) return;
        pending = true;
        try {
          const next = await loadTeamRows();
          if (active) {
            setRows(next.rows);
            setHostLabel(next.hostLabel);
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
      // Device-authenticated mobile sessions have no thread event stream.
      const timer = setInterval(() => void refresh(), TEAM_REFRESH_MS);
      const clock = setInterval(() => setNow(Date.now()), TEAM_REFRESH_MS);
      return () => {
        active = false;
        clearInterval(timer);
        clearInterval(clock);
      };
    }, [retry]),
  );
  const act = async (row: TeamRow, action: "stop" | "accept") => {
    setBusy(row.botId);
    try {
      await (action === "stop" ? stopTeamTask(row) : acceptTeamTask(row));
      const next = await loadTeamRows();
      setRows(next.rows);
      setHostLabel(next.hostLabel);
    } catch {
      Alert.alert(t("Could not update this task; try again."));
    } finally {
      setBusy(null);
    }
  };
  return (
    <View style={[styles.page, { backgroundColor: tokens.background }]}>
      <Stack.Screen options={{ title: t("Team") }} />
      <Button title={t("Comparisons")} onPress={() => router.push("/comparisons")} />
      {!loaded && !error ? <ActivityIndicator /> : null}
      {error ? (
        <View>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {t("Could not load Team; retry.")}
          </Text>
          <Button title={t("Retry")} onPress={() => setRetry((value) => value + 1)} />
        </View>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(row) => row.botId}
        renderItem={({ item: row }) => {
          const item = mobileTeamRow(row, t, hostLabel, now);
          return (
            <View
              style={[styles.row, { borderColor: tokens.border, backgroundColor: tokens.card }]}
            >
              <Text style={[styles.name, { color: tokens.foreground }]}>{item.name}</Text>
              {item.computerName ? (
                <Text style={{ color: tokens.mutedForeground }}>{item.computerName}</Text>
              ) : null}
              <Text numberOfLines={2} style={{ color: tokens.foreground }}>
                {item.text}
              </Text>
              {row.observedAt &&
              now - Date.parse(row.observedAt) >= 30_000 &&
              now - Date.parse(row.observedAt) < 60_000 ? (
                <Text style={{ color: tokens.mutedForeground }}>{t("Updated 1m ago")}</Text>
              ) : null}
              {(row.activeRunCount ?? 0) > 1 ? (
                <Text style={{ color: tokens.mutedForeground }}>
                  {t("{count} active tasks", { count: row.activeRunCount ?? 0 })}
                </Text>
              ) : null}
              {row.latestDeliveryState ? (
                <Text style={{ color: tokens.mutedForeground }}>
                  {t("Latest message")}: {teamDeliveryText(row.latestDeliveryState, t)}
                </Text>
              ) : null}
              {row.pendingPeerCount ? (
                <Text style={{ color: tokens.mutedForeground }}>
                  {t("{count} peer messages waiting", { count: row.pendingPeerCount })}
                </Text>
              ) : null}
              {row.state === "waiting-approval" && row.requesterName ? (
                <Text style={{ color: tokens.mutedForeground }}>
                  {t("Requested by")} {row.requesterName} — {t("acting as")} {row.botName}
                </Text>
              ) : null}
              {row.executing ? (
                <Text style={{ color: tokens.mutedForeground }}>
                  {row.executing.pin.modelId} ·{" "}
                  {runtimeEffortLabel(
                    row.executing.pin,
                    row.executing.runtimeInfo,
                    t("requested"),
                  ) ?? "—"}
                </Text>
              ) : null}
              <View style={styles.actions}>
                {row.latestPeerBotId ? (
                  <Button
                    title={t("Conversation with {name}", {
                      name: row.latestPeerBotName ?? t("Bot"),
                    })}
                    color={tokens.foreground}
                    onPress={() =>
                      router.push({ pathname: "/thread", params: { botId: row.botId } })
                    }
                  />
                ) : null}
                {item.stop ? (
                  <Button
                    title={t("Stop")}
                    color={tokens.foreground}
                    disabled={busy !== null}
                    onPress={() => void act(row, "stop")}
                  />
                ) : null}
                {item.accept ? (
                  <Button
                    title={t("Accept")}
                    color={tokens.foreground}
                    disabled={busy !== null}
                    onPress={() => void act(row, "accept")}
                  />
                ) : null}
                {row.action ? (
                  <Button
                    title={t("Open conversation")}
                    color={tokens.foreground}
                    onPress={() =>
                      router.push({
                        pathname: "/thread",
                        params: {
                          botId:
                            row.chain.find((item) => item.role === "reviewer")?.id ?? row.botId,
                        },
                      })
                    }
                  />
                ) : null}
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, padding: 16 },
  row: { borderWidth: 1, borderRadius: 12, padding: 16, gap: 8, marginBottom: 8 },
  name: { fontSize: 17, fontWeight: "600" },
  actions: { flexDirection: "row", gap: 8 },
});
