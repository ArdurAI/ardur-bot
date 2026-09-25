import type { BoardPatch, BoardView, WorkItem } from "@ardurbot/contracts/board";
import { BoardPatchSchema, BoardViewSchema, boardColumn } from "@ardurbot/contracts/board";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Button,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc, selectedSpaceId } from "../lib/api";
import { hasPairedDevice } from "../lib/dispatch";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

const columns = [
  { id: "ready", status: "open", label: "Ready" },
  { id: "in_progress", status: "in_progress", label: "In progress" },
  { id: "blocked", status: "blocked", label: "Blocked" },
  { id: "deferred", status: "deferred", label: "Deferred" },
  { id: "done", status: "closed", label: "Done" },
] as const;
export function MobileBoard() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const params = useLocalSearchParams<{ workspace?: string; item?: string }>();
  const [data, setData] = useState<BoardView | null>(null);
  const [column, setColumn] = useState("ready");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readOnly, setReadOnly] = useState(true);
  const [retry, setRetry] = useState(0);
  const [title, setTitle] = useState("");
  const [comment, setComment] = useState("");
  const [filters, setFilters] = useState({ text: "", label: "", assignee: "", bot: "" });
  const [filtersReady, setFiltersReady] = useState(false);
  const [undo, setUndo] = useState<{
    workspaceId: string;
    id: string;
    patch: BoardPatch;
  } | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const mutation = useRef(false);
  const selection = useRef(0);
  const key = `ardurbot.board-filters.${selectedSpaceId() ?? "default"}`;
  useEffect(() => {
    let active = true;
    void hasPairedDevice().then((paired) => {
      if (active) setReadOnly(paired);
    });
    void SecureStore.getItemAsync(key)
      .then((value) => {
        if (!value || !active) return;
        const saved = JSON.parse(value);
        setFilters({
          text: typeof saved.text === "string" ? saved.text : "",
          label: typeof saved.label === "string" ? saved.label : "",
          assignee: typeof saved.assignee === "string" ? saved.assignee : "",
          bot: typeof saved.bot === "string" ? saved.bot : "",
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setFiltersReady(true);
      });
    return () => {
      active = false;
    };
  }, [key]);
  useEffect(() => {
    if (filtersReady)
      void SecureStore.setItemAsync(key, JSON.stringify(filters)).catch(() => undefined);
  }, [key, filters, filtersReady]);
  useFocusEffect(
    useCallback(() => {
      const abort = new AbortController();
      const ticket = ++selection.current;
      const load = async () => {
        await pending.current;
        if (
          abort.signal.aborted ||
          mutation.current ||
          AppState.currentState === "background" ||
          AppState.currentState === "inactive"
        )
          return;
        const request = rpc(
          "board/view",
          { workspaceId: params.workspace, itemId: params.item || undefined },
          { signal: abort.signal },
        )
          .then((response) => {
            if (!abort.signal.aborted && ticket === selection.current) {
              setData(BoardViewSchema.parse(response));
              setError(false);
            }
          })
          .catch(() => {
            if (!abort.signal.aborted && ticket === selection.current) setError(true);
          })
          .finally(() => {
            if (pending.current === request) pending.current = null;
          });
        pending.current = request;
        await request;
      };
      void load();
      const timer = setInterval(() => {
        if (!pending.current) void load();
      }, 15_000);
      return () => {
        abort.abort();
        clearInterval(timer);
      };
    }, [params.workspace, params.item, retry]),
  );
  const selected = data?.selected;
  const workspaceId = data?.workspaceId;
  async function work(action: () => Promise<unknown>) {
    if (mutation.current || readOnly) return;
    mutation.current = true;
    setBusy(true);
    setError(false);
    try {
      await action();
      setRetry((n) => n + 1);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      mutation.current = false;
    }
  }
  const selectItem = (id?: string) => {
    ++selection.current;
    setData((current) =>
      current ? { ...current, selected: null, selectionProblem: null } : current,
    );
    setComment("");
    router.setParams({ view: "board", workspace: workspaceId ?? params.workspace, item: id ?? "" });
  };
  const move = (item: WorkItem, status: NonNullable<BoardPatch["status"]>) =>
    work(async () => {
      if (!workspaceId) return;
      const before = data;
      const updated = {
        ...item,
        status,
        deferUntil: null,
        closedAt: status === "closed" ? new Date().toISOString() : null,
      };
      setData((current) =>
        current
          ? {
              ...current,
              selected: current.selected?.id === item.id ? updated : current.selected,
              snapshot: {
                ...current.snapshot,
                items: current.snapshot.items.map((row) => (row.id === item.id ? updated : row)),
                readyIds: [
                  ...current.snapshot.readyIds.filter((id) => id !== item.id),
                  ...(status === "open" ? [item.id] : []),
                ],
                blockedIds: [
                  ...current.snapshot.blockedIds.filter((id) => id !== item.id),
                  ...(status === "blocked" ? [item.id] : []),
                ],
              },
            }
          : null,
      );
      try {
        await rpc("board/update", {
          workspaceId,
          id: item.id,
          patch: { status, deferUntil: null },
        });
        const previous = BoardPatchSchema.shape.status.safeParse(item.status);
        if (previous.success)
          setUndo({
            workspaceId,
            id: item.id,
            patch: { status: previous.data, deferUntil: item.deferUntil },
          });
      } catch (error) {
        setData((current) =>
          current && before && current.workspaceId === before.workspaceId
            ? {
                ...current,
                snapshot: before.snapshot,
                selected: current.selected?.id === item.id ? item : current.selected,
              }
            : current,
        );
        throw error;
      }
    });
  const membership = {
    readyIds: new Set(data?.snapshot.readyIds),
    blockedIds: new Set(data?.snapshot.blockedIds),
  };
  const items =
    data?.snapshot.items.filter(
      (item) =>
        boardColumn(item, membership) === column &&
        (!filters.text ||
          `${item.title} ${item.description} ${item.id}`
            .toLowerCase()
            .includes(filters.text.toLowerCase())) &&
        (!filters.label || item.labels.includes(filters.label)) &&
        (!filters.assignee || item.assignee === filters.assignee) &&
        (!filters.bot || item.assignee === `bot:${filters.bot}`),
    ) ?? [];
  const foreground = { color: tokens.foreground };
  const failure =
    error || data?.problem || data?.selectionProblem ? (
      <View>
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {data?.selectionProblem ? t("Could not load") : t("Could not load Board; retry.")}
        </Text>
        <Button title={t("Retry")} disabled={busy} onPress={() => setRetry((n) => n + 1)} />
        {data?.selectionProblem ? <Button title={t("Close")} onPress={() => selectItem()} /> : null}
      </View>
    ) : null;
  return (
    <View style={styles.page}>
      {!data && !error ? <ActivityIndicator /> : null}
      {!selected ? failure : null}
      {readOnly ? <Text style={foreground}>{t("Sign in to manage boards.")}</Text> : null}
      {data && !workspaceId ? (
        <View>
          <Text style={foreground}>{t("No board")}</Text>
          <Button title={t("Set up a board")} onPress={() => router.push("/boards-settings")} />
        </View>
      ) : null}
      {workspaceId ? (
        <>
          <ScrollView horizontal style={{ flexGrow: 0 }}>
            {data?.workspaces.map((board) => (
              <Button
                key={board.id}
                title={board.name}
                disabled={board.id === workspaceId}
                onPress={() => {
                  setData(null);
                  router.setParams({ view: "board", workspace: board.id, item: "" });
                }}
              />
            ))}
          </ScrollView>
          <ScrollView horizontal style={{ flexGrow: 0 }}>
            {columns.map((entry) => (
              <Button
                key={entry.id}
                title={t(entry.label)}
                disabled={entry.id === column}
                onPress={() => setColumn(entry.id)}
              />
            ))}
          </ScrollView>
          <View style={styles.filters}>
            {(["text", "label", "assignee", "bot"] as const).map((key) => (
              <TextInput
                key={key}
                accessibilityLabel={t(
                  key === "text"
                    ? "Search"
                    : key === "label"
                      ? "Label"
                      : key === "assignee"
                        ? "Assignee"
                        : "Bot",
                )}
                placeholder={t(
                  key === "text"
                    ? "Search"
                    : key === "label"
                      ? "Label"
                      : key === "assignee"
                        ? "Assignee"
                        : "Bot",
                )}
                placeholderTextColor={tokens.mutedForeground}
                style={[styles.input, foreground, { borderColor: tokens.border }]}
                value={filters[key]}
                onChangeText={(value) => setFilters((prior) => ({ ...prior, [key]: value }))}
              />
            ))}
          </View>
          {!readOnly ? (
            <View style={styles.row}>
              <TextInput
                accessibilityLabel={t("New item")}
                placeholder={t("New item")}
                placeholderTextColor={tokens.mutedForeground}
                value={title}
                maxLength={500}
                style={[styles.input, foreground, { borderColor: tokens.border }]}
                onChangeText={setTitle}
              />
              <Button
                title={t("Add")}
                disabled={busy || !title.trim()}
                onPress={() =>
                  void work(async () => {
                    const item = await rpc<WorkItem>("board/create", {
                      workspaceId,
                      item: { title: title.trim(), type: "task", priority: 2 },
                    });
                    setTitle("");
                    const status = columns.find((entry) => entry.id === column)?.status;
                    if (status !== "open")
                      await rpc("board/update", { workspaceId, id: item.id, patch: { status } });
                  })
                }
              />
            </View>
          ) : null}
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View
                style={[styles.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}
              >
                <Button title={item.title} onPress={() => selectItem(item.id)} />
                <Text style={foreground}>
                  {item.id} · P{item.priority}
                  {item.assignee ? ` · ${item.assignee}` : ""}
                </Text>
                {item.filedBy ? (
                  <Text style={foreground}>
                    {t("Filed by {name}", { name: item.filedBy.botName })}
                  </Text>
                ) : null}
              </View>
            )}
          />
        </>
      ) : null}
      {undo ? (
        <View style={styles.row}>
          <Text style={foreground}>{t("Item updated")}</Text>
          <Button
            title={t("Undo")}
            disabled={busy}
            onPress={() =>
              void work(async () => {
                await rpc("board/update", undo);
                setUndo(null);
              })
            }
          />
          <Button title={t("Dismiss")} onPress={() => setUndo(null)} />
        </View>
      ) : null}
      <Modal
        visible={Boolean(selected)}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={() => selectItem()}
      >
        <ScrollView
          style={{ backgroundColor: tokens.background }}
          contentContainerStyle={{ padding: 16, gap: 12 }}
          keyboardShouldPersistTaps="handled"
        >
          <Button title={t("Close")} onPress={() => selectItem()} />
          {failure}
          {selected ? (
            <>
              <Text accessibilityRole="header" style={[styles.title, foreground]}>
                {selected.title}
              </Text>
              {selected.filedBy ? (
                <Text style={foreground}>
                  {t("Filed by {name}", { name: selected.filedBy.botName })}
                </Text>
              ) : null}
              <Text style={foreground}>{selected.description}</Text>
              {selected.acceptanceCriteria ? (
                <>
                  <Text style={[styles.title, foreground]}>{t("Acceptance criteria")}</Text>
                  <Text style={foreground}>{selected.acceptanceCriteria}</Text>
                </>
              ) : null}
              {!readOnly ? (
                <>
                  <Text style={foreground}>{t("Status")}</Text>
                  <View style={styles.row}>
                    {columns.map((entry) => (
                      <Button
                        key={entry.id}
                        title={t(entry.label)}
                        disabled={busy || selected.status === entry.status}
                        onPress={() => void move(selected, entry.status)}
                      />
                    ))}
                  </View>
                  <Button
                    title={data?.followingIds.includes(selected.id) ? t("Unfollow") : t("Follow")}
                    disabled={busy}
                    onPress={() =>
                      void work(() =>
                        rpc("board/follow", {
                          workspaceId,
                          id: selected.id,
                          following: !data?.followingIds.includes(selected.id),
                        }),
                      )
                    }
                  />
                  <Text style={[styles.title, foreground]}>{t("Send to bot")}</Text>
                  {data?.bots.map((bot) => (
                    <Button
                      key={bot.id}
                      title={bot.name}
                      disabled={busy || selected.status === "closed"}
                      onPress={() =>
                        void work(async () => {
                          await rpc("board/send", {
                            workspaceId,
                            id: selected.id,
                            botId: bot.id,
                            clientNonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                          });
                          router.push({ pathname: "/thread", params: { botId: bot.id } });
                        })
                      }
                    />
                  ))}
                </>
              ) : null}
              {(["incoming", "outgoing"] as const).map((direction) => (
                <View key={direction}>
                  <Text style={[styles.title, foreground]}>
                    {t(direction === "incoming" ? "Blocks" : "Blocked by")}
                  </Text>
                  {selected.dependencies
                    .filter((edge) => edge.direction === direction)
                    .map((edge) => (
                      <Button
                        key={`${edge.id}:${edge.type}`}
                        title={edge.id}
                        onPress={() => selectItem(edge.id)}
                      />
                    ))}
                </View>
              ))}
              <Text style={[styles.title, foreground]}>{t("History")}</Text>
              {selected.history.map((entry) => (
                <Text key={entry.id} style={foreground}>
                  {entry.message} · {entry.createdAt}
                </Text>
              ))}
              <Text style={[styles.title, foreground]}>{t("Comments")}</Text>
              {selected.comments.map((entry) => (
                <View key={entry.id} style={styles.card}>
                  <Text style={{ color: tokens.mutedForeground }}>{entry.author}</Text>
                  <Text style={foreground}>{entry.text}</Text>
                </View>
              ))}
              {!readOnly ? (
                <>
                  <TextInput
                    accessibilityLabel={t("Comment")}
                    placeholder={t("Comment")}
                    multiline
                    style={[styles.input, foreground, { borderColor: tokens.border }]}
                    value={comment}
                    onChangeText={setComment}
                  />
                  <Button
                    title={t("Comment")}
                    disabled={busy || !comment.trim()}
                    onPress={() =>
                      void work(async () => {
                        await rpc("board/comment", { workspaceId, id: selected.id, text: comment });
                        setComment("");
                      })
                    }
                  />
                </>
              ) : null}
            </>
          ) : null}
        </ScrollView>
      </Modal>
    </View>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, padding: 16, gap: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  input: { borderWidth: 1, borderRadius: 8, padding: 10, minWidth: 120, flexGrow: 1 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 12, marginBottom: 8 },
  title: { fontSize: 18, fontWeight: "600" },
});
