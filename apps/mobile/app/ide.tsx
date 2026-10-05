import type { IdeEntry, IdeRoot, WorkspaceContext } from "@ardurbot/contracts";
import { COMPUTER_CHANGED_MESSAGE, WorkspaceReadCancelled, WorkspaceReads } from "@ardurbot/core";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Button, ScrollView, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { hasPairedDevice } from "../lib/dispatch";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { actionMessage, RpcServerError } from "../lib/rpc-error";

/** Native file browsing uses the same registered-root authorization as the IDE. */
export default function FilesScreen() {
  const { botId } = useLocalSearchParams<{ botId?: string }>();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [roots, setRoots] = useState<IdeRoot[]>([]);
  const [rootId, setRootId] = useState("");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<IdeEntry[]>([]);
  const [file, setFile] = useState<{ content: string; binary: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [paired, setPaired] = useState<boolean | null>(null);
  const [rootsReady, setRootsReady] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceContext | null>(null);
  const reads = useRef<WorkspaceReads | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      reads.current?.dispose();
    };
  }, []);
  const currentBot = useRef(botId);
  if (currentBot.current !== botId) {
    reads.current?.dispose();
    reads.current = null;
  }
  currentBot.current = botId;
  const selection = JSON.stringify([botId, rootId, path, retry]);
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  const scopedWorkspace = workspace?.botId === botId ? workspace : null;
  useEffect(() => {
    const abort = new AbortController();
    reads.current?.dispose();
    reads.current = null;
    setBusy(false);
    setError(null);
    setFile(null);
    setPath("");
    setEntries([]);
    setWorkspace(null);
    setRootsReady(false);
    void hasPairedDevice()
      .then(async (paired) => {
        if (abort.signal.aborted) return;
        setPaired(paired);
        if (paired) return;
        if (botId) {
          const context = await rpc<WorkspaceContext>(
            "workspace/describe",
            { botId },
            { signal: abort.signal },
          );
          if (!abort.signal.aborted && context.botId === botId) {
            reads.current = new WorkspaceReads(context, {
              describe: (botId) => rpc<WorkspaceContext>("workspace/describe", { botId }),
              computerChanged: (error) =>
                error instanceof RpcServerError &&
                error.code === "CONFLICT" &&
                error.message === COMPUTER_CHANGED_MESSAGE,
              publish: (next) => {
                if (alive.current && currentBot.current === botId) {
                  setWorkspace(next);
                  if (
                    next.computerId !== context.computerId ||
                    next.rootId !== context.rootId ||
                    next.files === "unavailable"
                  ) {
                    setFile(null);
                    setPath("");
                    setEntries([]);
                    setBusy(false);
                  }
                }
              },
            });
            setWorkspace(context);
            setRootsReady(true);
            setError(null);
          }
          return;
        }
        const rows = await rpc<IdeRoot[]>("ide/roots", {}, { signal: abort.signal });
        return rows;
      })
      .then((rows) => {
        if (rows && !abort.signal.aborted) {
          setRoots(rows);
          setRootId(rows[0]?.id ?? "");
          setRootsReady(true);
          setError(null);
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted && !(error instanceof WorkspaceReadCancelled))
          setError(actionMessage(error, "Could not load"));
      });
    return () => abort.abort();
  }, [botId, retry, t]);
  useEffect(() => {
    if (botId && !reads.current) return;
    if (
      botId
        ? !scopedWorkspace?.computerId ||
          scopedWorkspace.generation === null ||
          scopedWorkspace.files === "unavailable"
        : !rootId
    )
      return;
    const abort = new AbortController();
    setBusy(true);
    setError(null);
    const request =
      botId && scopedWorkspace?.computerId && scopedWorkspace.generation !== null
        ? reads.current!.read((binding) =>
            rpc<{ entries: IdeEntry[] }>(
              "workspace/list",
              {
                botId: binding.botId,
                computerId: binding.computerId!,
                generation: binding.generation!,
                rootId: binding.rootId,
                path,
              },
              { signal: abort.signal },
            ),
          )
        : rpc<{ entries: IdeEntry[] }>("ide/list", { rootId, path }, { signal: abort.signal });
    void request
      .then((result) => {
        if (!abort.signal.aborted) setEntries(result.entries);
      })
      .catch((error) => {
        if (!abort.signal.aborted && !(error instanceof WorkspaceReadCancelled))
          setError(actionMessage(error, "Could not load"));
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [
    botId,
    scopedWorkspace?.computerId,
    scopedWorkspace?.rootId,
    scopedWorkspace?.files,
    rootId,
    path,
    retry,
    t,
  ]);
  async function open(entry: IdeEntry) {
    if (entry.kind === "dir") {
      setPath(entry.path);
      return;
    }
    const owner = reads.current;
    const selected = selection;
    setBusy(true);
    setError(null);
    try {
      if (botId && scopedWorkspace?.computerId && scopedWorkspace.generation !== null) {
        const result = await reads.current!.read((binding) =>
          rpc<{ path: string; content: string; binary?: boolean }>("workspace/read", {
            botId: binding.botId,
            computerId: binding.computerId!,
            generation: binding.generation!,
            rootId: binding.rootId,
            path: entry.path,
          }),
        );
        if (
          alive.current &&
          reads.current === owner &&
          currentBot.current === botId &&
          currentSelection.current === selected
        )
          setFile({ content: result.content, binary: result.binary === true });
      } else {
        const result = await rpc<{ content: string; binary: boolean }>("ide/read", {
          rootId,
          path: entry.path,
        });
        if (
          alive.current &&
          reads.current === owner &&
          currentBot.current === botId &&
          currentSelection.current === selected &&
          !botId
        )
          setFile(result);
      }
    } catch (error) {
      if (
        alive.current &&
        reads.current === owner &&
        currentBot.current === botId &&
        currentSelection.current === selected &&
        !(error instanceof WorkspaceReadCancelled)
      )
        setError(actionMessage(error, "Could not load"));
    } finally {
      if (
        alive.current &&
        reads.current === owner &&
        currentBot.current === botId &&
        currentSelection.current === selected
      )
        setBusy(false);
    }
  }
  if (paired)
    return (
      <View style={{ padding: 16 }}>
        <Stack.Screen options={{ title: t("Files") }} />
        <Text style={{ color: tokens.foreground }}>{t("Sign in to browse files.")}</Text>
      </View>
    );
  return (
    <ScrollView
      style={{ backgroundColor: tokens.background }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      <Stack.Screen options={{ title: t("Files") }} />
      {!error && (busy || !rootsReady) ? <ActivityIndicator /> : null}
      {error ? (
        <View>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {t(error)}
          </Text>
          <Button title={t("Retry")} onPress={() => setRetry((n) => n + 1)} />
        </View>
      ) : null}
      {botId && scopedWorkspace?.files === "unavailable" ? (
        <Text style={{ color: tokens.mutedForeground }}>
          {t("Files are unavailable on this computer.")}
        </Text>
      ) : null}
      {botId && scopedWorkspace && scopedWorkspace.files !== "unavailable" ? (
        <Text style={{ color: tokens.mutedForeground }}>
          {scopedWorkspace.files === "live" ? t("Live files") : t("Saved files")}
        </Text>
      ) : null}
      {file ? (
        <>
          <Button title={t("Back")} onPress={() => setFile(null)} />
          <Text style={{ color: tokens.mutedForeground }}>
            {t("Open the IDE on desktop to edit.")}
          </Text>
          <Text selectable style={{ color: tokens.foreground }}>
            {file.binary ? t("Binary file") : file.content}
          </Text>
        </>
      ) : (
        <>
          {!botId &&
            roots.map((root) => (
              <Button
                key={root.id}
                title={root.name}
                disabled={busy || rootId === root.id}
                onPress={() => {
                  setRootId(root.id);
                  setPath("");
                }}
              />
            ))}
          {path ? (
            <Button
              title={t("Back")}
              onPress={() => setPath(path.split("/").slice(0, -1).join("/"))}
            />
          ) : null}
          {!botId && rootsReady && !roots.length && !error ? (
            <Text style={{ color: tokens.foreground }}>{t("No registered folders")}</Text>
          ) : null}
          {entries.map((entry) => (
            <Button
              key={entry.path}
              title={entry.path.split("/").at(-1) ?? entry.path}
              disabled={busy}
              onPress={() => void open(entry)}
            />
          ))}
        </>
      )}
    </ScrollView>
  );
}
