import type {
  MemoryDocumentHead,
  MemoryHistoryRevision,
  MemorySyncState,
} from "@ardurbot/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import {
  loadMemoryDestination,
  loadMemoryDocuments,
  loadMemoryHistory,
  loadMemorySyncState,
  memoryAttribution,
} from "../lib/memory";
import { native, useThemedStyles } from "../lib/native";

export default function Memory() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [destination, setDestination] = useState<string | null>(null);
  const [sync, setSync] = useState<MemorySyncState | null>(null);
  const [documents, setDocuments] = useState<MemoryDocumentHead[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<MemoryDocumentHead | null>(null);
  const [history, setHistory] = useState<MemoryHistoryRevision[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const ticket = useRef(0);
  useFocusEffect(
    useCallback(() => {
      const current = ++ticket.current;
      setOpen(null);
      setHistory([]);
      setBusy(true);
      setDestination(null);
      void loadMemoryDestination()
        .then((value) => {
          if (current === ticket.current) setDestination(value);
        })
        .catch(() => undefined);
      void loadMemorySyncState()
        .then((value) => {
          if (current === ticket.current) setSync(value);
        })
        .catch(() => undefined);
      void loadMemoryDocuments()
        .then((page) => {
          if (current === ticket.current) {
            setDocuments(page.items);
            setCursor(page.nextCursor);
            setError(false);
          }
        })
        .catch(() => {
          if (current === ticket.current) setError(true);
        })
        .finally(() => {
          if (current === ticket.current) setBusy(false);
        });
      return () => {
        ticket.current += 1;
      };
    }, [refresh]),
  );
  async function show(document: MemoryDocumentHead) {
    const current = ++ticket.current;
    setOpen(document);
    setHistory([]);
    setBusy(true);
    setError(false);
    try {
      const page = await loadMemoryHistory(document.id);
      if (current === ticket.current) {
        setHistory(page.items);
        setHistoryCursor(page.nextCursor);
      }
    } catch {
      if (current === ticket.current) setError(true);
    } finally {
      if (current === ticket.current) setBusy(false);
    }
  }
  async function more() {
    const current = ticket.current;
    setBusy(true);
    setError(false);
    try {
      if (open && historyCursor) {
        const page = await loadMemoryHistory(open.id, historyCursor);
        if (current === ticket.current) {
          setHistory((items) => [...items, ...page.items]);
          setHistoryCursor(page.nextCursor);
        }
      } else if (!open && cursor) {
        const page = await loadMemoryDocuments(cursor);
        if (current === ticket.current) {
          setDocuments((items) => [...items, ...page.items]);
          setCursor(page.nextCursor);
        }
      }
    } catch {
      if (current === ticket.current) setError(true);
    } finally {
      if (current === ticket.current) setBusy(false);
    }
  }
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.secondary}>
          {t("Memory is read-only here. Edit it in Settings on desktop or web.")}
        </Text>
        {destination ? (
          <Text style={styles.secondary}>
            {t("Sends memory text to")} {destination}
          </Text>
        ) : null}
        {sync ? (
          <Text style={styles.secondary}>
            {t("Syncs to")} {sync.host}
          </Text>
        ) : null}
        {sync?.status === "last-copy" ? (
          <Text style={styles.secondary}>{t("Working from the last copy")}</Text>
        ) : null}
        {sync?.status === "quarantined" ? (
          <Text style={styles.error}>
            {t("Repository history changed. Review the saved copy on desktop or web.")}
          </Text>
        ) : null}
        {error ? (
          <View>
            <Text accessibilityRole="alert" style={styles.error}>
              {t("Could not load memory. Try again.")}
            </Text>
            <Pressable
              disabled={busy}
              accessibilityRole="button"
              onPress={() => (open ? void show(open) : setRefresh((value) => value + 1))}
            >
              <Text style={styles.title}>{t("Retry")}</Text>
            </Pressable>
          </View>
        ) : null}
        {busy ? <ActivityIndicator /> : null}
        {open ? (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                ticket.current += 1;
                setOpen(null);
                setBusy(false);
              }}
            >
              <Text style={styles.title}>{t("Documents")}</Text>
            </Pressable>
            <Text style={styles.title}>{open.path}</Text>
            <Text selectable style={styles.body}>
              {open.content}
            </Text>
            <Text style={styles.title}>{t("History")}</Text>
            {history.map((revision) => (
              <View key={revision.revision} style={styles.card}>
                <Text style={styles.title}>
                  {t("Revision")} {revision.revision}
                </Text>
                <Text style={styles.secondary}>{memoryAttribution(revision)}</Text>
                <Text style={styles.secondary}>
                  {new Date(revision.createdAt).toLocaleString()}
                </Text>
                <Text selectable style={styles.body}>
                  {revision.content || t("Deleted")}
                </Text>
              </View>
            ))}
          </>
        ) : (
          documents.map((doc) => (
            <Pressable
              accessibilityRole="button"
              key={doc.id}
              onPress={() => void show(doc)}
              style={styles.card}
            >
              <Text style={styles.title}>{doc.path}</Text>
              <Text style={styles.secondary}>
                {t("Revision")} {doc.revision}
                {doc.deletedAt ? ` · ${t("Deleted")}` : ""}
              </Text>
              {doc.gitSync ? (
                <Text style={styles.secondary}>
                  {doc.gitSync.status === "pushed"
                    ? t("Pushed")
                    : doc.gitSync.status === "failed"
                      ? t("Saved locally. GitHub sync failed.")
                      : t("Saved locally. Sync pending.")}
                </Text>
              ) : null}
              {doc.delivery.status !== "delivered" ? (
                <Text style={styles.secondary}>
                  {doc.delivery.status === "pending"
                    ? t("Saved locally. Indexing pending.")
                    : t("Saved locally. Indexing failed.")}
                </Text>
              ) : null}
            </Pressable>
          ))
        )}
        {(open ? historyCursor : cursor) ? (
          <Pressable disabled={busy} accessibilityRole="button" onPress={() => void more()}>
            <Text style={styles.title}>{t("Load more")}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 16, gap: 14 },
    card: { padding: 14, gap: 6, borderRadius: 12, backgroundColor: mobileTokens().card },
    title: { fontSize: 16, fontWeight: "600", color: native.label },
    body: { fontSize: 15, color: native.label },
    secondary: { fontSize: 13, color: native.secondaryLabel },
    error: { color: mobileTokens().destructive, fontSize: 14 },
  });
}
