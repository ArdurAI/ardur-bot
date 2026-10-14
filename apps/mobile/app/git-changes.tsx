import type { GitStatusEntry, WorkspaceContext, WorkspaceGit } from "@ardurbot/contracts";
import { COMPUTER_CHANGED_MESSAGE, WorkspaceReadCancelled, WorkspaceReads } from "@ardurbot/core";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Button, ScrollView, Text, View } from "react-native";
import { GitChangesDiff, GitChangesList } from "../components/git-changes";
import { rpc } from "../lib/api";
import { hasPairedDevice } from "../lib/dispatch";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { actionMessage, RpcServerError } from "../lib/rpc-error";

function bindingInput(binding: WorkspaceContext, path?: string) {
  return {
    botId: binding.botId,
    computerId: binding.computerId!,
    generation: binding.generation!,
    ...(binding.rootId ? { rootId: binding.rootId } : {}),
    ...(path ? { path } : {}),
  };
}

/** Read-only Git changes for the bot's live workspace. Paired devices stay signed out. */
export default function GitChangesScreen() {
  const { botId } = useLocalSearchParams<{ botId?: string }>();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [paired, setPaired] = useState<boolean | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceContext | null>(null);
  const [status, setStatus] = useState<WorkspaceGit["status"] | null>(null);
  const [entries, setEntries] = useState<GitStatusEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<NonNullable<WorkspaceGit["diff"]> | null>(null);
  const [diffState, setDiffState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const reads = useRef<WorkspaceReads | null>(null);
  const alive = useRef(true);
  const listEpoch = useRef(0);
  const diffEpoch = useRef(0);
  const currentBot = useRef(botId);
  currentBot.current = botId;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      reads.current?.dispose();
    };
  }, []);

  const loadList = useCallback(async (owner: WorkspaceReads) => {
    const epoch = ++listEpoch.current;
    setStatus(null);
    setSelected(null);
    setDiff(null);
    setError(null);
    try {
      const result = await owner.read((binding) =>
        rpc<WorkspaceGit>("workspace/git", bindingInput(binding)),
      );
      if (!alive.current || epoch !== listEpoch.current || reads.current !== owner) return;
      setWorkspace(result.context);
      setStatus(result.status);
      setEntries(result.status === "ok" ? (result.entries ?? []) : []);
      setTruncated(result.truncated === true);
    } catch (caught) {
      if (!alive.current || epoch !== listEpoch.current || caught instanceof WorkspaceReadCancelled)
        return;
      setEntries([]);
      if (caught instanceof RpcServerError) setError(actionMessage(caught, "Could not load"));
      else setStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    reads.current?.dispose();
    reads.current = null;
    setWorkspace(null);
    setStatus(null);
    setEntries([]);
    setSelected(null);
    setDiff(null);
    setError(null);
    setBusy(true);
    void hasPairedDevice()
      .then(async (isPaired) => {
        if (abort.signal.aborted) return;
        setPaired(isPaired);
        if (isPaired || !botId) {
          setBusy(false);
          return;
        }
        const context = await rpc<WorkspaceContext>(
          "workspace/describe",
          { botId },
          { signal: abort.signal },
        );
        if (abort.signal.aborted || !alive.current || context.botId !== botId) return;
        let published = context;
        const owner = new WorkspaceReads(context, {
          describe: (id) => rpc<WorkspaceContext>("workspace/describe", { botId: id }),
          computerChanged: (caught) =>
            caught instanceof RpcServerError &&
            caught.code === "CONFLICT" &&
            caught.message === COMPUTER_CHANGED_MESSAGE,
          publish: (next) => {
            if (!alive.current || currentBot.current !== botId) return;
            const previous = published;
            published = next;
            setWorkspace(next);
            if (
              next.computerId !== previous.computerId ||
              next.rootId !== previous.rootId ||
              next.files !== "live" ||
              next.git !== true
            ) {
              listEpoch.current += 1;
              setEntries([]);
              setSelected(null);
              setDiff(null);
              setStatus(next.files === "live" && next.git === true ? null : "unavailable");
            }
          },
        });
        reads.current = owner;
        setWorkspace(context);
        if (
          context.git !== true ||
          context.files !== "live" ||
          !context.computerId ||
          context.generation === null
        ) {
          setStatus("unavailable");
          return;
        }
        await loadList(owner);
      })
      .catch((caught) => {
        if (!abort.signal.aborted && !(caught instanceof WorkspaceReadCancelled))
          setError(actionMessage(caught, "Could not load"));
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [botId, retry, loadList]);

  async function open(path: string) {
    const owner = reads.current;
    if (!owner) return;
    const epoch = ++diffEpoch.current;
    setSelected(path);
    setDiff(null);
    setDiffState("loading");
    setError(null);
    try {
      const result = await owner.read((binding) =>
        rpc<WorkspaceGit>("workspace/git", bindingInput(binding, path)),
      );
      if (!alive.current || epoch !== diffEpoch.current || reads.current !== owner) return;
      if (result.status !== "ok" || !result.diff) {
        setDiffState("error");
        return;
      }
      setDiff(result.diff);
      setDiffState("ready");
    } catch (caught) {
      if (!alive.current || epoch !== diffEpoch.current || caught instanceof WorkspaceReadCancelled)
        return;
      setDiff(null);
      setDiffState("error");
      if (caught instanceof RpcServerError) setError(actionMessage(caught, "Could not open file"));
    }
  }

  if (paired) {
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: tokens.background }}>
        <Stack.Screen options={{ title: t("Git changes") }} />
        <Text style={{ color: tokens.foreground }}>{t("Sign in to browse files.")}</Text>
      </View>
    );
  }
  const unavailable =
    status === "unavailable" ||
    (workspace !== null &&
      (workspace.git !== true || workspace.files !== "live") &&
      status !== "ok" &&
      status !== "not-repository");
  return (
    <View style={{ flex: 1, backgroundColor: tokens.background }}>
      <Stack.Screen options={{ title: t("Git changes") }} />
      <View style={{ flexDirection: "row", justifyContent: "flex-end", padding: 8 }}>
        {selected ? (
          <Button
            title={t("Git changes")}
            onPress={() => {
              diffEpoch.current += 1;
              setSelected(null);
              setDiff(null);
            }}
          />
        ) : (
          <Button
            title={t("Refresh")}
            onPress={() => {
              const owner = reads.current;
              if (owner) void loadList(owner);
              else setRetry((count) => count + 1);
            }}
          />
        )}
      </View>
      {error ? (
        <View style={{ paddingHorizontal: 16 }}>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {t(error)}
          </Text>
          <Button title={t("Retry")} onPress={() => setRetry((count) => count + 1)} />
        </View>
      ) : null}
      {busy && status === null && !error ? <ActivityIndicator /> : null}
      {selected ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
          <GitChangesDiff path={selected} diff={diff} state={diffState} />
        </ScrollView>
      ) : !error && unavailable ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive, padding: 16 }}>
          {t("Git changes are unavailable on this computer.")}
        </Text>
      ) : status === "not-repository" ? (
        <Text style={{ color: tokens.mutedForeground, padding: 16 }}>
          {t("Not a Git repository")}
        </Text>
      ) : status === "ok" ? (
        <GitChangesList
          entries={entries}
          truncated={truncated}
          onOpen={(path) => void open(path)}
        />
      ) : status === null && !busy ? (
        <Text style={{ color: tokens.mutedForeground, padding: 16 }}>{t("Loading…")}</Text>
      ) : null}
    </View>
  );
}
