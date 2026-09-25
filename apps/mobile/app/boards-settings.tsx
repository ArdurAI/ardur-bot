import type { BoardConfiguration, BoardProblem, BoardWorkspace } from "@ardurbot/contracts/board";
import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Button,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { hasPairedDevice } from "../lib/dispatch";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export default function BoardsSettings() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [boards, setBoards] = useState<BoardWorkspace[]>([]);
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<BoardProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [owner, setOwner] = useState(false);
  const board = boards.find((row) => row.id === selected) ?? boards[0];
  useEffect(() => setName(board?.name ?? ""), [board?.id, board?.name]);
  async function load() {
    const [result, bots] = await Promise.all([
      rpc<{ workspaces: BoardWorkspace[]; problem: BoardProblem | null }>("board/workspaces", {}),
      rpc<{ id: string; name: string }[]>("bots/list"),
    ]);
    setBoards(result.workspaces);
    setBots(bots);
    setProblem(result.problem);
    setLoaded(true);
  }
  useEffect(() => {
    void (async () => {
      if (await hasPairedDevice()) {
        setLoaded(true);
        return;
      }
      const me = await rpc<{ isDeploymentOwner: boolean }>("me");
      setOwner(me.isDeploymentOwner);
      if (me.isDeploymentOwner) await load();
      else setLoaded(true);
    })().catch(() => setError(true));
  }, []);
  async function work(action: () => Promise<unknown>) {
    if (busy || !owner) return;
    setBusy(true);
    setError(false);
    try {
      await action();
      await load();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  const configure = (patch: BoardConfiguration) =>
    board && work(() => rpc("board/configure", { workspaceId: board.id, patch }));
  const foreground = { color: tokens.foreground };
  return (
    <ScrollView
      style={{ backgroundColor: tokens.background }}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: t("Boards") }} />
      {!loaded && !error ? <ActivityIndicator /> : null}
      {error || problem ? (
        <View>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {t("Could not load Board; retry.")}
          </Text>
          <Button title={t("Retry")} onPress={() => void work(load)} />
        </View>
      ) : null}
      {loaded && !owner ? (
        <Text style={foreground}>{t("Sign in as the owner to configure boards.")}</Text>
      ) : null}
      {owner ? (
        <>
          <Text style={[styles.heading, foreground]}>{t("Beads")}</Text>
          <Text style={foreground}>
            {problem?.code === "not_installed"
              ? t("Beads is not installed on this computer")
              : problem
                ? t("Not connected")
                : t("Connected")}
          </Text>
          <Button title={t("Refresh")} disabled={busy} onPress={() => void work(load)} />
          <Text style={[styles.heading, foreground]}>{t("Registered folders")}</Text>
          {boards.map((row) => (
            <Button
              key={row.id}
              title={`${row.name}${row.enabled ? "" : ` · ${t("Archived")}`}`}
              disabled={row.id === board?.id}
              onPress={() => setSelected(row.id)}
            />
          ))}
          {board ? (
            <>
              <Text style={[styles.heading, foreground]}>
                {board.kind === "space" ? t("Space board") : t("Folder board")}
              </Text>
              <TextInput
                accessibilityLabel={t("Name")}
                style={[styles.input, foreground, { borderColor: tokens.border }]}
                value={name}
                maxLength={100}
                onChangeText={setName}
              />
              <Button
                title={t("Save")}
                disabled={busy || !name.trim()}
                onPress={() => void configure({ name: name.trim() })}
              />
              <Text style={foreground}>
                {!board.enabled
                  ? t("Archived")
                  : board.initialized
                    ? t("Ready")
                    : t("Not initialized")}
              </Text>
              {board.kind === "folder" ? (
                <Text style={{ color: tokens.mutedForeground }}>{board.path}</Text>
              ) : null}
              {board.enabled && !board.initialized ? (
                <Button
                  title={t("Start board")}
                  disabled={busy}
                  onPress={() =>
                    Alert.alert(
                      t("Start board?"),
                      t("Creates .beads/ in this folder. Git files and hooks stay unchanged."),
                      [
                        { text: t("Cancel"), style: "cancel" },
                        {
                          text: t("Confirm"),
                          onPress: () =>
                            void work(() => rpc("board/start", { workspaceId: board.id })),
                        },
                      ],
                    )
                  }
                />
              ) : null}
              <Button
                title={board.isDefault ? t("Default board") : t("Make default")}
                disabled={busy || board.isDefault || !board.enabled || !board.initialized}
                onPress={() => void configure({ isDefault: true })}
              />
              <View style={styles.row}>
                <Text style={foreground}>{t("All bots")}</Text>
                <Switch
                  accessibilityLabel={t("All bots")}
                  value={board.allowAllBots}
                  disabled={busy}
                  onValueChange={(value) => void configure({ allowAllBots: value })}
                />
              </View>
              {!board.allowAllBots ? (
                <>
                  <Text style={[styles.heading, foreground]}>{t("Allowed bots")}</Text>
                  {bots.map((bot) => (
                    <View key={bot.id} style={styles.row}>
                      <Text style={foreground}>{bot.name}</Text>
                      <Switch
                        accessibilityLabel={bot.name}
                        value={board.allowedBotIds.includes(bot.id)}
                        disabled={busy}
                        onValueChange={(value) =>
                          void configure({
                            allowedBotIds: value
                              ? [...board.allowedBotIds, bot.id]
                              : board.allowedBotIds.filter((id) => id !== bot.id),
                          })
                        }
                      />
                    </View>
                  ))}
                </>
              ) : null}
              {board.enabled ? (
                <Button
                  title={t("Archive board")}
                  disabled={busy}
                  onPress={() =>
                    Alert.alert(t("Archive board?"), t("Board files will be kept."), [
                      { text: t("Cancel"), style: "cancel" },
                      {
                        text: t("Archive"),
                        style: "destructive",
                        onPress: () => void configure({ enabled: false }),
                      },
                    ])
                  }
                />
              ) : (
                <Button
                  title={t("Restore")}
                  disabled={busy}
                  onPress={() => void configure({ enabled: true })}
                />
              )}
            </>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  page: { padding: 16, gap: 12 },
  heading: { fontSize: 17, fontWeight: "600" },
  input: { borderWidth: 1, borderRadius: 8, padding: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
});
