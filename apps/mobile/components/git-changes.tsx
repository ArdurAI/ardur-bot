import type { GitChangeKind, GitStatusEntry } from "@ardurbot/contracts";
import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import {
  diffLinePrefix,
  GIT_CHANGE_ORDER,
  gitDiffWithheld,
  gitEntryChange,
  textDiffLines,
} from "../lib/git-changes";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

function statusLabel(kind: GitChangeKind, t: (message: string) => string): string {
  switch (kind) {
    case "added":
      return t("Added");
    case "modified":
      return t("Modified");
    case "deleted":
      return t("Deleted");
    case "untracked":
      return t("Untracked");
  }
}

/** Native list of changed paths, grouped by status, with a count on each group. */
export function GitChangesList({
  entries,
  truncated = false,
  onOpen,
}: {
  entries: GitStatusEntry[];
  truncated?: boolean;
  onOpen: (path: string) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const sections = GIT_CHANGE_ORDER.map((kind) => ({
    kind,
    title: statusLabel(kind, t),
    data: entries.filter((entry) => gitEntryChange(entry) === kind),
  })).filter((section) => section.data.length > 0);
  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.path}
      style={{ backgroundColor: tokens.background }}
      ListEmptyComponent={
        truncated ? null : (
          <Text style={[styles.message, { color: tokens.mutedForeground }]}>
            {t("No changes to show")}
          </Text>
        )
      }
      ListFooterComponent={
        truncated ? (
          <Text style={[styles.message, { color: tokens.mutedForeground }]}>
            {t("Some changes are not shown")}
          </Text>
        ) : null
      }
      renderSectionHeader={({ section }) => (
        <Text
          accessibilityLabel={`${section.title} ${section.data.length}`}
          style={[styles.heading, { color: tokens.mutedForeground }]}
        >
          {section.title} {section.data.length}
        </Text>
      )}
      renderItem={({ item, section }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${section.title} ${item.path}`}
          onPress={() => onOpen(item.path)}
          style={[styles.row, { borderBottomColor: tokens.border }]}
        >
          <Text numberOfLines={1} style={[styles.path, { color: tokens.foreground }]}>
            {item.path}
          </Text>
        </Pressable>
      )}
    />
  );
}

/** Read-only text diff. Added and removed lines carry a prefix, not only a color. */
export function GitChangesDiff({
  path,
  diff,
  state,
}: {
  path: string;
  diff: {
    before: string | null;
    after: string | null;
    binary: boolean;
    truncated: boolean;
  } | null;
  state: "loading" | "ready" | "error";
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const withheld = diff !== null && gitDiffWithheld(diff);
  const lines =
    diff && !diff.binary && !diff.truncated && !withheld
      ? textDiffLines(diff.before, diff.after)
      : [];
  return (
    <View style={{ gap: 8 }}>
      <Text style={[styles.path, { color: tokens.mutedForeground }]}>{path}</Text>
      {state === "loading" ? (
        <Text accessibilityRole="text" style={{ color: tokens.mutedForeground }}>
          {t("Loading…")}
        </Text>
      ) : null}
      {state === "error" ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {t("Could not open file")}
        </Text>
      ) : null}
      {state === "ready" && diff?.binary ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("Binary file")}</Text>
      ) : null}
      {state === "ready" && withheld ? (
        <Text style={{ color: tokens.mutedForeground }}>
          {t("This file looks like it contains a secret.")}
        </Text>
      ) : null}
      {state === "ready" && diff && !diff.binary && !withheld && diff.truncated ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("Diff is too large")}</Text>
      ) : null}
      {lines.map((line, index) => (
        <Text
          key={`${line.kind}:${index}:${line.text}`}
          accessibilityLabel={`${diffLinePrefix(line.kind)}${line.text}`}
          style={[
            styles.diffLine,
            {
              color:
                line.kind === "added"
                  ? tokens.success
                  : line.kind === "removed"
                    ? tokens.destructive
                    : tokens.foreground,
            },
          ]}
        >
          {diffLinePrefix(line.kind)}
          {line.text}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 13, fontWeight: "600", paddingHorizontal: 16, paddingTop: 16 },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 12 },
  path: { fontFamily: "monospace", fontSize: 13 },
  message: { fontSize: 15, padding: 16 },
  diffLine: { fontFamily: "monospace", fontSize: 13, paddingHorizontal: 16 },
});
