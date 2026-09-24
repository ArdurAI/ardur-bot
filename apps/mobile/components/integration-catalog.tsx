import type { IntegrationCatalogList } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { AppState, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { integrationCardMessage, loadIntegrationCatalog } from "../lib/integration-catalog";
import { native, useThemedStyles } from "../lib/native";

export function IntegrationCatalog() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [data, setData] = useState<IntegrationCatalogList>();
  const [error, setError] = useState(false);
  async function load() {
    try {
      setData(await loadIntegrationCatalog(rpc));
      setError(false);
    } catch {
      setError(true);
    }
  }
  useEffect(() => {
    void load();
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => listener.remove();
  }, []);
  return (
    <View style={styles.list}>
      {error ? (
        <View style={styles.card}>
          <Text style={styles.secondary}>{t("Could not load integrations.")}</Text>
          <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.button}>
            <Text style={styles.label}>{t("Try again")}</Text>
          </Pressable>
        </View>
      ) : null}
      {data?.catalog.map((descriptor) => {
        const connection = data.connections.find((entry) => entry.catalogId === descriptor.id);
        const url =
          connection?.state === "needs-client-registration" && descriptor.authKind !== "token"
            ? descriptor.docsUrl
            : data.webUrl;
        return (
          <View key={descriptor.id} testID={`integration-${descriptor.id}`} style={styles.card}>
            <Text style={styles.title}>{descriptor.name}</Text>
            <Text style={styles.secondary}>
              {t(integrationCardMessage(descriptor, connection))}
            </Text>
            {descriptor.available && url ? (
              <Pressable
                accessibilityRole="link"
                style={styles.button}
                onPress={() => void Linking.openURL(url).catch(() => setError(true))}
              >
                <Text style={styles.label}>
                  {t(
                    url === descriptor.docsUrl
                      ? "Open documentation"
                      : connection?.state === "connected"
                        ? "Manage on web"
                        : "Connect on web",
                  )}
                </Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    list: { gap: 12 },
    card: { padding: 16, gap: 12, borderRadius: 16, backgroundColor: native.fill },
    title: { color: native.label, fontSize: 16, fontWeight: "600" },
    secondary: { color: native.secondaryLabel, fontSize: 14 },
    button: {
      minHeight: 44,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: native.fillPressed,
      borderRadius: 12,
    },
    label: { color: native.label, fontSize: 14, fontWeight: "600" },
  });
}
