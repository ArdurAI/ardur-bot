import type { TeamRow } from "@ardurbot/contracts";
import { TEAM_REFRESH_MS } from "@ardurbot/core";
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
  const [loaded, setLoaded] = useState(false);
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
      // Device-authenticated mobile sessions have no thread event stream.
      const timer = setInterval(() => void refresh(), TEAM_REFRESH_MS);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [retry]),
  );
  const act = async (row: TeamRow, action: "stop" | "accept") => {
    setBusy(row.botId);
    try {
      await (action === "stop" ? stopTeamTask(row) : acceptTeamTask(row));
      setRows(await loadTeamRows());
    } catch {
      Alert.alert(t("Could not update this task; try again."));
    } finally {
      setBusy(null);
    }
  };
  return (
    <View style={[styles.page, { backgroundColor: tokens.background }]}>
      <Stack.Screen options={{ title: t("Team") }} />
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
          const item = mobileTeamRow(row, t);
          return (
            <View
              style={[styles.row, { borderColor: tokens.border, backgroundColor: tokens.card }]}
            >
              <Text style={[styles.name, { color: tokens.foreground }]}>{item.name}</Text>
              <Text numberOfLines={2} style={{ color: tokens.foreground }}>
                {item.text}
              </Text>
              {row.state === "waiting-approval" && row.requesterName ? (
                <Text style={{ color: tokens.mutedForeground }}>
                  {t("Requested by")} {row.requesterName} — {t("acting as")} {row.botName}
                </Text>
              ) : null}
              <View style={styles.actions}>
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
