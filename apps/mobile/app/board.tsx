import type { BoardWorkspace, WorkItem } from "@ardurbot/contracts/board";
import { Stack, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Button,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { boardProblemText, loadBoardItem, loadBoardReady, loadBoardWorkspaces } from "../lib/board";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export default function BoardScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [workspaces, setWorkspaces] = useState<BoardWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [items, setItems] = useState<WorkItem[]>([]);
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const load = async () => {
        try {
          const found = await loadBoardWorkspaces();
          if (!active) return;
          if (found.problem) {
            setError(boardProblemText(found.problem, t));
            return;
          }
          const boards = found.workspaces.filter((board) => board.enabled && board.initialized);
          setWorkspaces(boards);
          const current = boards.find((board) => board.id === workspaceId) ?? boards[0];
          if (!current) {
            setItems([]);
            return;
          }
          if (workspaceId !== current.id) setWorkspaceId(current.id);
          const ready = await loadBoardReady(current.id);
          if (active) {
            setItems(ready);
            setError("");
          }
        } catch {
          if (active) setError("Could not load Board; retry.");
        } finally {
          if (active) setLoading(false);
        }
      };
      void load();
      const timer = setInterval(() => void load(), 15_000);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [workspaceId, retry, t]),
  );
  const open = async (id: string) => {
    setLoading(true);
    try {
      setSelected(await loadBoardItem(workspaceId, id));
    } catch {
      setError("Could not load Board; retry.");
    } finally {
      setLoading(false);
    }
  };
  return (
    <View style={[styles.page, { backgroundColor: tokens.background }]}>
      <Stack.Screen options={{ title: t("Board") }} />
      {loading ? <ActivityIndicator /> : null}
      {error ? (
        <View>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {t(error)}
          </Text>
          <Button title={t("Retry")} onPress={() => setRetry((value) => value + 1)} />
        </View>
      ) : null}
      {selected ? (
        <ScrollView>
          <Button title={t("Ready")} onPress={() => setSelected(null)} />
          <Text style={[styles.title, { color: tokens.foreground }]}>{selected.title}</Text>
          <Text style={{ color: tokens.mutedForeground }}>
            {selected.id} · P{selected.priority}
          </Text>
          <Text style={{ color: tokens.foreground }}>{selected.description}</Text>
          {selected.acceptanceCriteria ? (
            <View style={styles.section}>
              <Text style={[styles.title, { color: tokens.foreground }]}>
                {t("Acceptance criteria")}
              </Text>
              <Text style={{ color: tokens.foreground }}>{selected.acceptanceCriteria}</Text>
            </View>
          ) : null}
          {(["incoming", "outgoing"] as const).map((direction) => (
            <View key={direction} style={styles.section}>
              <Text style={[styles.title, { color: tokens.foreground }]}>
                {t(direction === "incoming" ? "Blocks" : "Blocked by")}
              </Text>
              {selected.dependencies
                .filter((edge) => edge.direction === direction)
                .map((edge) => (
                  <Button
                    key={`${edge.id}:${edge.type}`}
                    title={edge.id}
                    onPress={() => void open(edge.id)}
                  />
                ))}
            </View>
          ))}
          {selected.comments.map((comment) => (
            <View key={comment.id} style={styles.section}>
              <Text style={{ color: tokens.mutedForeground }}>{comment.author}</Text>
              <Text style={{ color: tokens.foreground }}>{comment.text}</Text>
            </View>
          ))}
        </ScrollView>
      ) : (
        <>
          {workspaces.length > 1 ? (
            <View>
              {workspaces.map((board) => (
                <Button
                  key={board.id}
                  title={board.kind === "space" ? t("Board") : board.name}
                  disabled={board.id === workspaceId}
                  onPress={() => {
                    setWorkspaceId(board.id);
                    setItems([]);
                  }}
                />
              ))}
            </View>
          ) : null}
          <Text style={[styles.title, { color: tokens.foreground }]}>{t("Ready")}</Text>
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View
                style={[styles.row, { borderColor: tokens.border, backgroundColor: tokens.card }]}
              >
                <Button
                  title={item.title}
                  color={tokens.foreground}
                  onPress={() => void open(item.id)}
                />
                <Text style={{ color: tokens.mutedForeground }}>
                  {item.id} · P{item.priority}
                </Text>
              </View>
            )}
          />
        </>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, padding: 16 },
  title: { fontSize: 18, fontWeight: "600", marginVertical: 8 },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 12, marginBottom: 8 },
  section: { marginVertical: 12 },
});
