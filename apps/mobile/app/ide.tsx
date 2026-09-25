import type { IdeEntry, IdeFile, IdeRoot } from "@ardurbot/contracts";
import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Button, ScrollView, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** Native file browsing uses the same registered-root authorization as the IDE. */
export default function FilesScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [roots, setRoots] = useState<IdeRoot[]>([]);
  const [rootId, setRootId] = useState("");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<IdeEntry[]>([]);
  const [file, setFile] = useState<IdeFile | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void rpc<IdeRoot[]>("ide/roots", {}, { signal: abort.signal })
      .then((rows) => {
        if (!abort.signal.aborted) {
          setRoots(rows);
          setRootId(rows[0]?.id ?? "");
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, [retry]);
  useEffect(() => {
    if (!rootId) return;
    const abort = new AbortController();
    setBusy(true);
    setError(false);
    void rpc<{ entries: IdeEntry[] }>("ide/list", { rootId, path }, { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) setEntries(result.entries);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [rootId, path, retry]);
  async function open(entry: IdeEntry) {
    if (entry.kind === "dir") {
      setPath(entry.path);
      return;
    }
    setBusy(true);
    setError(false);
    try {
      setFile(await rpc<IdeFile>("ide/read", { rootId, path: entry.path }));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView
      style={{ backgroundColor: tokens.background }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      <Stack.Screen options={{ title: t("Files") }} />
      {busy ? <ActivityIndicator /> : null}
      {error ? (
        <View>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {t("Could not load")}
          </Text>
          <Button title={t("Retry")} onPress={() => setRetry((n) => n + 1)} />
        </View>
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
          {roots.map((root) => (
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
          {!roots.length && !error ? (
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
