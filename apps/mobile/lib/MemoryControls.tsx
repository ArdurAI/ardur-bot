import type { LearningProposal, SpaceLearningConfig } from "@ardurbot/contracts";
import { MEMORY_IMPORT_PROMPT } from "@ardurbot/contracts";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Button, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { mobileTokens } from "./appearance";
import { proposeMemoryChange, setMemoryGeneration } from "./capability-settings";
import { useI18n } from "./i18n";
import { loadLearningSettings } from "./learning";
import { native, useThemedStyles } from "./native";

export function MemoryControls() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [settings, setSettings] = useState<SpaceLearningConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const ticket = useRef(0);
  const locked = useRef(false);
  useFocusEffect(
    useCallback(() => {
      const current = ++ticket.current;
      void loadLearningSettings()
        .then((value) => {
          if (ticket.current === current) setSettings(value);
        })
        .catch(() => {
          if (ticket.current === current) setError(true);
        });
      return () => {
        ticket.current++;
      };
    }, []),
  );
  async function change(enabled: boolean) {
    if (!settings?.canConfigure || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    const current = ticket.current;
    try {
      const result = await setMemoryGeneration(settings, enabled);
      if (ticket.current === current) setSettings(result);
    } catch {
      if (ticket.current === current) setError(true);
    } finally {
      locked.current = false;
      if (ticket.current === current) setBusy(false);
    }
  }
  return (
    <View style={styles.content}>
      <View style={styles.row}>
        <Text style={styles.title}>{t("Generate memory from chats")}</Text>
        <Switch
          accessibilityLabel={t("Generate memory from chats")}
          value={settings?.enabled ?? false}
          disabled={
            busy || !settings?.canConfigure || (!settings.enabled && !settings.destination?.modelId)
          }
          onValueChange={(value) => void change(value)}
        />
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t("Could not save memory settings. Try again.")}
        </Text>
      ) : null}
    </View>
  );
}
export function MemoryIntentControls() {
  const { t } = useI18n();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState("");
  const [instruction, setInstruction] = useState("");
  const [items, setItems] = useState<LearningProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const locked = useRef(false);
  const ticket = useRef(0);
  useFocusEffect(
    useCallback(() => {
      ticket.current++;
      return () => {
        ticket.current++;
      };
    }, []),
  );
  async function propose(intent: "import" | "edit") {
    if (locked.current) return;
    const value = (intent === "import" ? text : instruction).trim();
    if (!value) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    const current = ticket.current;
    try {
      const proposals = await proposeMemoryChange({
        intent,
        text: value,
        requestId: `memory-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      if (ticket.current !== current) return;
      setItems(proposals);
      if (intent === "import") setText("");
      else setInstruction("");
    } catch {
      if (ticket.current === current) setError(true);
    } finally {
      locked.current = false;
      if (ticket.current === current) setBusy(false);
    }
  }
  return (
    <View style={styles.content}>
      <Text style={styles.title}>{t("Import memory from other AI providers")}</Text>
      <Button title={t("Start import")} onPress={() => setImporting(true)} />
      {importing ? (
        <>
          <Text selectable style={styles.body}>
            {MEMORY_IMPORT_PROMPT}
          </Text>
          <Button
            title={t("Copy prompt")}
            onPress={() =>
              void Clipboard.setStringAsync(MEMORY_IMPORT_PROMPT).catch(() => setError(true))
            }
          />
          <TextInput
            accessibilityLabel={t("Paste memory")}
            placeholder={t("Paste memory")}
            value={text}
            onChangeText={setText}
            multiline
            maxLength={12000}
            style={styles.input}
            editable={!busy}
          />
          <Button
            title={t("Review import")}
            disabled={busy || !text.trim()}
            onPress={() => void propose("import")}
          />
        </>
      ) : null}
      {items.map((item) => (
        <View key={item.id} style={styles.card}>
          <Text style={styles.title}>
            {item.memoryAction === "delete"
              ? t("Remove memory")
              : item.documentKind === "profile"
                ? t("Profile")
                : item.documentKind === "preferences"
                  ? t("Preferences")
                  : t("Memory")}
          </Text>
          <Text selectable style={styles.body}>
            {item.memoryAction === "delete" ? item.diff : item.proposedContent}
          </Text>
          <Text style={styles.secondary}>{t("Pending approval")}</Text>
        </View>
      ))}
      {items.length ? (
        <Button title={t("Review proposals")} onPress={() => router.push("/learning")} />
      ) : null}
      <TextInput
        accessibilityLabel={t("Tell your bot what to change or remove")}
        placeholder={t("Tell your bot what to change or remove")}
        value={instruction}
        onChangeText={setInstruction}
        multiline
        maxLength={4000}
        editable={!busy}
        style={styles.input}
      />
      <Button
        title={t("Send")}
        disabled={busy || !instruction.trim()}
        onPress={() => void propose("edit")}
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t("Could not prepare memory changes. Try again.")}
        </Text>
      ) : null}
    </View>
  );
}
function createStyles() {
  return StyleSheet.create({
    content: { gap: 12 },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    title: { fontSize: 16, fontWeight: "600", color: native.label, flexShrink: 1 },
    body: { fontSize: 15, color: native.label },
    secondary: { fontSize: 14, color: native.secondaryLabel },
    error: { color: mobileTokens().destructive },
    input: {
      borderWidth: 1,
      borderColor: mobileTokens().border,
      borderRadius: 10,
      padding: 12,
      color: native.label,
      minHeight: 80,
    },
    card: { padding: 12, borderRadius: 10, backgroundColor: mobileTokens().card },
  });
}
