import type { IntegrationCatalogList } from "@ardurbot/contracts";
import type { ComposerCommand } from "@ardurbot/core";
import { truncateSlashDescription } from "@ardurbot/core";
import { useEffect, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { rpc } from "../lib/api";
import type { ComposerMenuOption } from "../lib/composer-menu";
import { COMPOSER_MENU_OPTIONS } from "../lib/composer-menu";
import { useI18n } from "../lib/i18n";
import { loadIntegrationCatalog } from "../lib/integration-catalog";
import { native, useMobileTokens, useThemedStyles } from "../lib/native";

export function ComposerSheet({
  mode,
  query,
  onQuery,
  commands,
  onCommand,
  onAction,
  onSettings,
  onClose,
}: {
  mode: "actions" | "slash" | "connectors" | "routines";
  query: string;
  onQuery: (value: string) => void;
  commands: readonly ComposerCommand[];
  onCommand: (command: ComposerCommand) => void;
  onAction: (option: ComposerMenuOption) => void;
  onSettings: (connectionId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const [integrations, setIntegrations] = useState<IntegrationCatalogList>({
    catalog: [],
    connections: [],
  });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (mode !== "connectors") return;
    let active = true;
    void loadIntegrationCatalog(rpc)
      .then((value) => {
        if (active) setIntegrations(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [mode]);
  const rows: Array<{
    id: string;
    name: string;
    description: string;
    onPress?: () => void;
    connected?: boolean;
  }> =
    mode === "actions"
      ? COMPOSER_MENU_OPTIONS.map((option) => ({
          id: option,
          name: t(option),
          description: "",
          onPress: () => onAction(option),
        }))
      : mode === "slash" || mode === "routines"
        ? commands
            .filter((command) => mode !== "routines" || command.kind === "routine")
            .map((command) => ({
              id: command.id,
              name: command.name,
              description: command.kind === "action" ? t(command.description) : command.description,
              onPress: () => onCommand(command),
            }))
        : integrations.connections.map((connection) => ({
            id: connection.id,
            name:
              integrations.catalog.find((item) => item.id === connection.catalogId)?.name ??
              connection.catalogId,
            description:
              connection.state === "connected" ? t("Connected") : t("Needs reconnection"),
            connected: connection.state === "connected",
            onPress: connection.state === "connected" ? undefined : () => onSettings(connection.id),
          }));
  return (
    <Modal
      visible
      presentationStyle="pageSheet"
      animationType={reducedMotion ? "none" : "slide"}
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.sheet}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>
            {mode === "slash"
              ? t("Slash commands")
              : mode === "routines"
                ? t("Routines")
                : mode === "connectors"
                  ? t("Connectors")
                  : ""}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Close")}
            onPress={onClose}
            hitSlop={12}
          >
            <Text style={styles.label}>{t("Close")}</Text>
          </Pressable>
        </View>
        {mode === "slash" ? (
          <TextInput
            autoFocus
            accessibilityLabel={t("Slash commands")}
            value={query}
            onChangeText={onQuery}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.search}
          />
        ) : null}
        {failed ? (
          <Text accessibilityRole="alert" style={styles.label}>
            {t("Could not load integrations")}
          </Text>
        ) : null}
        <FlatList
          data={rows}
          keyExtractor={(row) => row.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole={item.onPress ? "button" : "text"}
              disabled={!item.onPress}
              onPress={item.onPress}
              style={styles.row}
            >
              {item.connected !== undefined ? (
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: item.connected ? tokens.success : tokens.warning },
                  ]}
                />
              ) : null}
              <View style={styles.content}>
                <Text style={styles.label}>{item.name}</Text>
                {item.description ? (
                  <Text numberOfLines={1} style={styles.description}>
                    {truncateSlashDescription(item.description)}
                  </Text>
                ) : null}
              </View>
              {mode === "slash" ? <Text style={styles.description}>↵</Text> : null}
            </Pressable>
          )}
        />
      </SafeAreaView>
    </Modal>
  );
}

function createStyles() {
  return StyleSheet.create({
    sheet: { flex: 1, backgroundColor: native.page },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      padding: 20,
    },
    title: { color: native.label, fontSize: 18, fontWeight: "600" },
    label: { color: native.label, fontSize: 16 },
    description: { color: native.secondaryLabel, fontSize: 13 },
    search: {
      marginHorizontal: 20,
      padding: 12,
      borderRadius: 10,
      color: native.label,
      backgroundColor: native.fill,
    },
    row: {
      minHeight: 52,
      paddingHorizontal: 20,
      paddingVertical: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    dot: { width: 6, height: 6, borderRadius: 3 },
    content: { flex: 1 },
  });
}
