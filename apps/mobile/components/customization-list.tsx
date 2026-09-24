import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import type { MobileCustomizationKind, MobileCustomizationRow } from "../lib/customization";
import { loadCustomization } from "../lib/customization";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";

export function CustomizationRows({ rows }: { rows: MobileCustomizationRow[] }) {
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  return (
    <View style={styles.list}>
      {rows.length ? (
        rows.map((row) => (
          <View key={row.id} style={styles.row}>
            <Text style={styles.name}>{row.name}</Text>
            {row.description ? (
              <Text style={styles.detail}>
                {t("by you")} · {row.description}
              </Text>
            ) : null}
            <View style={styles.metadata}>
              <Text style={styles.detail}>{t(row.detail)}</Text>
              {row.badges.map((badge) => (
                <Text key={badge} style={styles.badge}>
                  {t(badge)}
                </Text>
              ))}
            </View>
            {row.status ? (
              <Text style={[styles.detail, row.status === "reconnect" && styles.warning]}>
                {row.status === "connected"
                  ? `✓ ${t("Connected")}`
                  : row.status === "reconnect"
                    ? `⚠ ${t("Needs reconnection")}`
                    : t("Disconnected")}
              </Text>
            ) : null}
            {row.date ? (
              <Text style={styles.date}>{new Date(row.date).toLocaleDateString()}</Text>
            ) : null}
          </View>
        ))
      ) : (
        <Text style={styles.detail}>{t("No items found.")}</Text>
      )}
    </View>
  );
}
export function CustomizationList({ kind }: { kind: MobileCustomizationKind }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [rows, setRows] = useState<MobileCustomizationRow[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    void loadCustomization(kind, (procedure) => rpc(procedure))
      .then(
        (rows) => {
          if (active) setRows(rows);
        },
        () => {
          if (active) setFailed(true);
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [kind, version]);
  const title =
    kind === "skills" ? t("Skills") : kind === "plugins" ? t("Plugins") : t("Connectors");
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title }} />
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder={t("Search")}
        placeholderTextColor={mobileTokens().mutedForeground}
        accessibilityLabel={t("Search")}
        autoCapitalize="none"
      />
      {loading ? (
        <ActivityIndicator accessibilityLabel={t("Loading")} />
      ) : failed ? (
        <View style={styles.list}>
          <Text style={styles.detail}>{t("Could not load this list.")}</Text>
          <Pressable accessibilityRole="button" onPress={() => setVersion((value) => value + 1)}>
            <Text style={styles.name}>{t("Try again")}</Text>
          </Pressable>
        </View>
      ) : (
        <CustomizationRows
          rows={rows.filter((row) =>
            `${row.name} ${row.description}`
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()),
          )}
        />
      )}
    </ScrollView>
  );
}
function createStyles() {
  const colors = mobileTokens();
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.background },
    content: { padding: 16, gap: 16 },
    search: {
      backgroundColor: colors.muted,
      color: colors.foreground,
      padding: 12,
      borderRadius: 10,
      fontSize: 16,
    },
    list: { backgroundColor: colors.card, borderRadius: 12, paddingHorizontal: 16 },
    row: {
      paddingVertical: 16,
      gap: 6,
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    name: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
    detail: { color: colors.mutedForeground, fontSize: 13, paddingVertical: 2 },
    metadata: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
    badge: {
      backgroundColor: colors.muted,
      color: colors.mutedForeground,
      fontSize: 12,
      paddingHorizontal: 7,
      paddingVertical: 3,
      borderRadius: 5,
    },
    date: { color: colors.mutedForeground, fontSize: 12 },
    warning: { color: colors.warning },
  });
}
