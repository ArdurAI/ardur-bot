import type { CommandBlock } from "@ardurbot/contracts";
import { commandOutput, commandSummary } from "@ardurbot/core";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { exportCommandRun } from "../lib/command-export";
import { t } from "../lib/i18n";

export function NativeCommandBlock({ block }: { block: CommandBlock }) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const tokens = mobileTokens();
  const exportRun = async () => {
    setExporting(true);
    setError(false);
    try {
      await exportCommandRun(block.runId);
    } catch {
      setError(true);
    } finally {
      setExporting(false);
    }
  };
  return (
    <View style={[styles.block, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={styles.control}
      >
        <Text numberOfLines={expanded ? undefined : 2} style={{ color: tokens.foreground }}>
          {commandSummary(block)}
        </Text>
        <Text style={{ color: tokens.mutedForeground }}>
          {block.startedAt ?? t("Not recorded")} · {block.outcome}
        </Text>
        {block.outcome === "unknown" ? (
          <Text style={{ color: tokens.mutedForeground }}>{t("Completion not recorded")}</Text>
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={styles.body}>
          <Text selectable style={{ color: tokens.mutedForeground }}>
            {block.computer ?? t("Not recorded")}
          </Text>
          <ScrollView style={styles.output} nestedScrollEnabled>
            <Text selectable style={[styles.mono, { color: tokens.foreground }]}>
              {commandOutput(block)}
            </Text>
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            disabled={exporting}
            accessibilityState={{ disabled: exporting }}
            onPress={() => void exportRun()}
            style={styles.control}
          >
            <Text style={{ color: tokens.foreground }}>{t("Export run")}</Text>
          </Pressable>
          {error ? (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {t("The export could not finish; try again.")}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { width: "100%", borderWidth: 1, borderRadius: 8 },
  control: { minHeight: 44, padding: 12, gap: 4 },
  body: { padding: 12, gap: 8 },
  output: { maxHeight: 320 },
  mono: { fontFamily: "monospace", fontSize: 12 },
});
