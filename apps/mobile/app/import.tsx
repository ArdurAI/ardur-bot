import type { McpServer } from "@ardurbot/contracts";
import type {
  LocalImportAction,
  LocalImportCategory,
  LocalImportFailure,
  LocalImportRead,
  LocalImportStop,
  LocalImportSummary,
  LocalImportTool,
} from "@ardurbot/contracts/local-import";
import {
  addLocalImportResult,
  LOCAL_IMPORT_CATEGORIES,
  LOCAL_IMPORT_EXCLUSIONS,
  LOCAL_IMPORT_PRIVACY,
  LOCAL_IMPORT_TOOL_NAMES,
} from "@ardurbot/contracts/local-import";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Button,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { localImport } from "../lib/local-import";
import { native, useThemedStyles } from "../lib/native";

type Status = Awaited<ReturnType<typeof localImport.status>>;
const defaults: LocalImportCategory[] = ["instructions", "memories", "skills", "servers"];

export default function LocalImport() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LocalImportStop | null>(null);
  const [selected, setSelected] = useState<Partial<Record<LocalImportTool, LocalImportCategory[]>>>(
    {},
  );
  const [folders, setFolders] = useState<Partial<Record<LocalImportTool, string>>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<LocalImportRead | null>(null);
  const [summary, setSummary] = useState<LocalImportSummary | null>(null);
  const [exclusions, setExclusions] = useState(false);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [credentialServer, setCredentialServer] = useState<string | null>(null);
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const labels: Record<LocalImportCategory, string> = {
    instructions: t("Instructions"),
    memories: t("Memories"),
    skills: t("Skills"),
    servers: t("MCP servers"),
    plugins: t("Plugins and extensions"),
    other: t("Other files"),
  };
  const stops: Record<LocalImportStop, string> = {
    host: t("Import could not finish. Check this computer is connected, then re-scan."),
    rescan: t("This scan is out of date. Re-scan, then try again."),
    failed: t("Import stopped because of an unexpected error. Re-scan, then try again."),
  };
  const reasons: Record<LocalImportFailure["reason"], string> = {
    credential: t("Looks like it contains a credential. Remove it from the file, then re-scan."),
    failed: t("Could not be saved."),
  };
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setBusy(true);
      setError(null);
      void (async () => {
        const initial = await localImport.status();
        if (!active) return;
        if (!initial.manifest) await localImport.run({ action: "scan" });
        const next = await localImport.status();
        if (active) {
          setStatus(next);
          setSelected(next.selection);
        }
      })()
        .catch(() => {
          if (active) setError("failed");
        })
        .finally(() => {
          if (active) setBusy(false);
        });
      return () => {
        active = false;
        setCredentialValues({});
        setCredentialServer(null);
      };
    }, []),
  );
  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setStatus(await localImport.status());
    } catch {
      setError("failed");
    } finally {
      setBusy(false);
    }
  }
  function choose(tool: LocalImportTool, category: LocalImportCategory, checked: boolean) {
    const prior = selected;
    const categories = selected[tool] ?? defaults;
    const next = {
      ...selected,
      [tool]: checked
        ? [...categories, category]
        : categories.filter((value) => value !== category),
    };
    setSelected(next);
    if (status?.autoImport)
      void work(async () => {
        try {
          await localImport.configure({ selection: next });
        } catch (error) {
          setSelected(prior);
          throw error;
        }
      });
  }
  async function run(action: LocalImportAction) {
    await work(async () => {
      setServers(null);
      setCredentialServer(null);
      setCredentialValues({});
      const response = await localImport.run(action);
      if (response.stopped) setError(response.stopped);
      if (response.preview) setPreview(response.preview);
      if (response.result) setSummary(addLocalImportResult(null, response));
      if (response.manifest) {
        setPreview(null);
        setSummary(null);
      }
    });
  }
  async function importAll() {
    const manifest = status?.manifest;
    if (!manifest) return;
    await work(async () => {
      let total: LocalImportSummary | null = null;
      for (const source of manifest.sources) {
        const categories = selected[source.tool] ?? defaults;
        if (
          !categories.length ||
          !manifest.items.some(
            (item) =>
              item.tool === source.tool && item.importable && categories.includes(item.category),
          )
        )
          continue;
        const response = await localImport.run({
          action: "import",
          scanId: manifest.scanId,
          tool: source.tool,
          categories,
        });
        total = addLocalImportResult(total, response);
        setSummary(total);
        if (response.stopped) {
          setError(response.stopped);
          return;
        }
      }
    });
  }
  async function retry(failure: LocalImportFailure) {
    const manifest = status?.manifest;
    if (!manifest) return;
    await work(async () => {
      const response = await localImport.run({
        action: "import",
        scanId: manifest.scanId,
        tool: failure.tool,
        categories: [failure.category],
        itemId: failure.itemId,
      });
      if (response.stopped) setError(response.stopped);
      else setSummary((current) => addLocalImportResult(current, response, failure));
    });
  }
  const manifest = status?.manifest;
  const result = summary?.result;
  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          {t(manifest?.platform === "darwin" ? "Found on this Mac" : "Found on this computer")}
        </Text>
        <Text style={styles.muted}>{t(LOCAL_IMPORT_PRIVACY)}</Text>
        <Button title={t("Excluded files")} onPress={() => setExclusions(!exclusions)} />
        {exclusions ? <Text style={styles.muted}>{t(LOCAL_IMPORT_EXCLUSIONS)}</Text> : null}
        <View style={styles.row}>
          <Button
            title={t("Re-scan")}
            disabled={busy}
            onPress={() => void run({ action: "scan" })}
          />
          <Button
            title={t("Import all")}
            disabled={
              busy ||
              !manifest?.items.some(
                (item) =>
                  item.importable && (selected[item.tool] ?? defaults).includes(item.category),
              )
            }
            onPress={() => void importAll()}
          />
        </View>
        {busy ? <ActivityIndicator accessibilityLabel={t("Working…")} /> : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {stops[error]}
          </Text>
        ) : null}
        {manifest?.limited ? (
          <Text style={styles.muted}>
            {manifest.unscanned
              ? t("Some items exceeded the scan limits ({count} items were not scanned).", {
                  count: manifest.unscanned,
                })
              : t("Some items exceeded the scan limits.")}
          </Text>
        ) : null}
        {result ? (
          <Text style={styles.text}>
            {t(
              "{created} imported, {updated} updated, {unchanged} unchanged, {removed} removed, {skipped} skipped, {conflicts} conflicts, {failed} failed.",
              result,
            )}
          </Text>
        ) : null}
        {summary?.failures.map((failure) => (
          <View key={failure.itemId} style={styles.group}>
            <Text selectable style={styles.text}>
              {failure.relativePath}
            </Text>
            <Text style={styles.muted}>{reasons[failure.reason]}</Text>
            {failure.reason === "failed" ? (
              <Button
                title={t("Retry")}
                accessibilityLabel={t("Retry {path}", { path: failure.relativePath })}
                disabled={busy}
                onPress={() => void retry(failure)}
              />
            ) : null}
          </View>
        ))}
        {result && result.conflicts > 0 ? (
          <Text style={styles.muted}>{t("Items edited after import were kept.")}</Text>
        ) : null}
        {status?.importedAt ? (
          <View style={styles.row}>
            <Text style={styles.text}>{t("Auto-import changes")}</Text>
            <Switch
              accessibilityLabel={t("Auto-import changes")}
              value={status.autoImport}
              disabled={busy}
              onValueChange={(autoImport) =>
                void work(async () => {
                  await localImport.configure({
                    autoImport,
                    selection: { ...status.selection, ...selected },
                  });
                })
              }
            />
          </View>
        ) : null}
        {status?.imported.length ? (
          <Button
            title={t("Set up servers")}
            disabled={busy}
            onPress={() =>
              void work(async () => {
                setServers(await localImport.servers());
              })
            }
          />
        ) : null}
        {servers
          ?.filter((server) => server.envKeys.length || server.headerKeys.length)
          .map((server) => (
            <View key={server.id} style={styles.card}>
              <Text style={styles.text}>{server.name}</Text>
              <Button
                title={server.hasSecret ? t("Update credentials") : t("Set up credentials")}
                disabled={busy}
                onPress={() => {
                  setCredentialServer(server.id);
                  setCredentialValues({});
                }}
              />
              {credentialServer === server.id ? (
                <>
                  {[
                    ...server.envKeys.map((key) => ({ id: `env:${key}`, key })),
                    ...server.headerKeys.map((key) => ({ id: `header:${key}`, key })),
                  ].map(({ id, key }) => (
                    <TextInput
                      key={id}
                      style={styles.input}
                      accessibilityLabel={key}
                      placeholder={key}
                      secureTextEntry
                      autoComplete="off"
                      autoCorrect={false}
                      autoCapitalize="none"
                      editable={!busy}
                      value={credentialValues[id] ?? ""}
                      onChangeText={(value) =>
                        setCredentialValues((current) => ({ ...current, [id]: value }))
                      }
                    />
                  ))}
                  <Button
                    title={t("Save credentials")}
                    disabled={busy}
                    onPress={() =>
                      void work(async () => {
                        await localImport.credentials({
                          serverId: server.id,
                          env: Object.fromEntries(
                            server.envKeys.map((key) => [
                              key,
                              credentialValues[`env:${key}`] ?? "",
                            ]),
                          ),
                          headers: Object.fromEntries(
                            server.headerKeys.map((key) => [
                              key,
                              credentialValues[`header:${key}`] ?? "",
                            ]),
                          ),
                        });
                        setCredentialValues({});
                        setCredentialServer(null);
                        setServers(await localImport.servers());
                      })
                    }
                  />
                  <Button
                    title={t("Cancel")}
                    disabled={busy}
                    onPress={() => {
                      setCredentialValues({});
                      setCredentialServer(null);
                    }}
                  />
                </>
              ) : null}
            </View>
          ))}
        {manifest?.sources.map((source) => {
          const name = LOCAL_IMPORT_TOOL_NAMES[source.tool];
          return (
            <View style={styles.card} key={source.tool}>
              <Text accessibilityRole="header" style={styles.title}>
                {name}
              </Text>
              {!source.detected ? <Text style={styles.muted}>{t("Not found")}</Text> : null}
              {source.memoryFolders > 0 ? (
                <Text style={styles.muted}>
                  {t("Memory folders: {folders} · Notes: {notes}", {
                    folders: source.memoryFolders,
                    notes: source.counts.memories,
                  })}
                </Text>
              ) : null}
              {LOCAL_IMPORT_CATEGORIES.filter((category) => source.counts[category] > 0).map(
                (category) => {
                  const items = manifest.items.filter(
                    (item) => item.tool === source.tool && item.category === category,
                  );
                  const key = `${source.tool}-${category}`;
                  const selection = selected[source.tool] ?? defaults;
                  const importable = items.some((item) => item.importable);
                  return (
                    <View key={category} style={styles.group}>
                      <View style={styles.row}>
                        <Text style={styles.text}>
                          {labels[category]} ({source.counts[category]})
                        </Text>
                        <Switch
                          accessibilityLabel={`${name} ${labels[category]}`}
                          value={importable && selection.includes(category)}
                          disabled={busy || !importable}
                          onValueChange={(checked) => choose(source.tool, category, checked)}
                        />
                      </View>
                      <Button
                        title={t("Preview {tool} {category}", {
                          tool: name,
                          category: labels[category],
                        })}
                        onPress={() => setOpen(open === key ? null : key)}
                      />
                      {open === key
                        ? items.map((item) => (
                            <View key={item.id} style={styles.group}>
                              {item.importable ? (
                                <Button
                                  title={item.name}
                                  disabled={busy}
                                  onPress={() =>
                                    void run({
                                      action: "preview",
                                      scanId: manifest.scanId,
                                      itemId: item.id,
                                    })
                                  }
                                />
                              ) : (
                                <Text style={styles.text}>{item.name}</Text>
                              )}
                              <Text selectable style={styles.muted}>
                                {item.relativePath}
                              </Text>
                              <Text style={styles.muted}>
                                {item.size} B · {new Date(item.modifiedAt).toLocaleString()}
                              </Text>
                              {item.reason ? <Text style={styles.muted}>{item.reason}</Text> : null}
                              <Text selectable style={styles.muted}>
                                {item.contentHash}
                              </Text>
                            </View>
                          ))
                        : null}
                    </View>
                  );
                },
              )}
              {source.defaultMissing ? (
                <View style={styles.group}>
                  <Button
                    title={t("Source folder for {tool}", { tool: name })}
                    onPress={() => setOpen(open === source.tool ? null : source.tool)}
                  />
                  {open === source.tool ? (
                    <>
                      <TextInput
                        style={styles.input}
                        accessibilityLabel={t("Source folder")}
                        placeholder={t("Folder inside your home")}
                        autoCapitalize="none"
                        autoCorrect={false}
                        value={folders[source.tool] ?? status?.roots[source.tool] ?? ""}
                        onChangeText={(value) =>
                          setFolders((current) => ({ ...current, [source.tool]: value }))
                        }
                        editable={!busy}
                      />
                      <Button
                        title={t("Use folder")}
                        disabled={busy || !(folders[source.tool] ?? status?.roots[source.tool])}
                        onPress={() =>
                          void work(async () => {
                            await localImport.configure({
                              roots: {
                                ...status?.roots,
                                [source.tool]:
                                  folders[source.tool] ?? status?.roots[source.tool] ?? "",
                              },
                            });
                            await localImport.run({ action: "scan" });
                          })
                        }
                      />
                    </>
                  ) : null}
                </View>
              ) : null}
              {status?.imported.some((entry) => entry.tool === source.tool && entry.count > 0) ? (
                <Button
                  color={mobileTokens().destructive}
                  title={t("Remove imported items from {tool}", { tool: name })}
                  disabled={busy}
                  onPress={() => void run({ action: "undo", tool: source.tool })}
                />
              ) : null}
            </View>
          );
        })}
        {preview ? (
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.title}>
              {preview.item.name}
            </Text>
            <Button title={t("Close preview")} onPress={() => setPreview(null)} />
            {preview.server?.envNames.length ? (
              <Text style={styles.muted}>
                {t("Environment values are requested when you connect this server.")}
              </Text>
            ) : null}
            <Text selectable style={styles.text}>
              {preview.content}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 16, gap: 16 },
    card: {
      padding: 16,
      gap: 12,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 12,
      backgroundColor: tokens.card,
    },
    title: { fontSize: 17, fontWeight: "600", color: tokens.foreground },
    text: { fontSize: 15, color: tokens.foreground, flexShrink: 1 },
    muted: { fontSize: 13, color: tokens.mutedForeground },
    error: { color: mobileTokens().destructive, fontSize: 14 },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    group: { gap: 8 },
    input: {
      padding: 12,
      borderColor: tokens.border,
      borderWidth: 1,
      borderRadius: 8,
      color: tokens.foreground,
    },
  });
}
