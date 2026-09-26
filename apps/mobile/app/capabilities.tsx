import type { CapabilityPreferences } from "@ardurbot/contracts";
import {
  ENGINE_MISSING_CODE,
  errorDataCode,
  HOST_MOVE_UNAVAILABLE_CODE,
} from "@ardurbot/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Button,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import {
  loadCapabilitySettings,
  saveCapabilitySettings,
  setComputerNetwork,
} from "../lib/capability-settings";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

export default function Capabilities() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [data, setData] = useState<Awaited<ReturnType<typeof loadCapabilitySettings>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const locked = useRef(false);
  useFocusEffect(
    useCallback(() => {
      const current = ++ticket.current;
      void loadCapabilitySettings()
        .then((value) => {
          if (ticket.current === current) {
            setData(value);
            setError(null);
          }
        })
        .catch(() => {
          if (ticket.current === current) setError(t("Could not save capabilities. Try again."));
        });
      return () => {
        ticket.current++;
      };
    }, [t]),
  );
  async function change(work: () => Promise<unknown>) {
    if (locked.current || !data?.canConfigure) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    const current = ticket.current;
    try {
      await work();
      const value = await loadCapabilitySettings();
      if (ticket.current === current) setData(value);
    } catch (caught) {
      if (ticket.current === current) {
        const code = errorDataCode(caught);
        setError(
          (code === ENGINE_MISSING_CODE || code === HOST_MOVE_UNAVAILABLE_CODE) &&
            caught instanceof Error
            ? caught.message
            : t("Could not save capabilities. Try again."),
        );
      }
    } finally {
      locked.current = false;
      if (ticket.current === current) setBusy(false);
    }
  }
  const disabled = busy || !data?.canConfigure;
  const toggle = (key: keyof CapabilityPreferences, value: boolean) =>
    void change(() => saveCapabilitySettings({ [key]: value }));
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {!data ? (
          <ActivityIndicator />
        ) : (
          <>
            <Text style={styles.title}>{t("Tool access mode")}</Text>
            <Text style={styles.secondary}>
              {t("Controls how connector tools are loaded in new conversations")}
            </Text>
            <Button
              disabled={disabled}
              title={
                data.settings.toolAccessMode === "all"
                  ? t("Load all connected tools")
                  : t("Load tools when needed")
              }
              onPress={() =>
                Alert.alert(t("Tool access mode"), undefined, [
                  {
                    text: t("Load tools when needed"),
                    onPress: () =>
                      void change(() => saveCapabilitySettings({ toolAccessMode: "when-needed" })),
                  },
                  {
                    text: t("Load all connected tools"),
                    onPress: () =>
                      void change(() => saveCapabilitySettings({ toolAccessMode: "all" })),
                  },
                  { text: t("Cancel"), style: "cancel" },
                ])
              }
            />
            <View style={styles.row}>
              <Text style={styles.title}>{t("Connector search")}</Text>
              <Switch
                accessibilityLabel={t("Connector search")}
                disabled={disabled}
                value={data.settings.connectorSearch}
                onValueChange={(value) => toggle("connectorSearch", value)}
              />
            </View>
            <Text style={styles.secondary}>
              {t(
                "Let the assistant search the connector directory and surface ones relevant to your conversation",
              )}
            </Text>
            <View style={styles.row}>
              <Text style={styles.title}>{t("Inline visualizations")}</Text>
              <Switch
                accessibilityLabel={t("Inline visualizations")}
                disabled={disabled}
                value={data.settings.inlineVisualizations}
                onValueChange={(value) => toggle("inlineVisualizations", value)}
              />
            </View>
            <Text style={styles.title}>{t("Code execution on computers")}</Text>
            <Button
              title={t("Computers")}
              onPress={() =>
                Alert.alert(
                  t("Computers"),
                  data.computers
                    .map((computer) => `${computer.name} (${computer.kind})`)
                    .join("\n"),
                )
              }
            />
            <Text style={styles.secondary}>
              {t(
                "Network access lets a bot install packages and reach the internet. This comes with security risks.",
              )}
            </Text>
            {data.computers.map((computer) => (
              <View key={computer.id} style={styles.card}>
                <Text style={styles.title}>{computer.name}</Text>
                <View style={styles.row}>
                  <Text style={styles.body}>{t("Allow network egress")}</Text>
                  <Switch
                    accessibilityLabel={`${t("Allow network egress")} — ${computer.name}`}
                    value={computer.networkEgress}
                    disabled={disabled || !computer.supported || computer.pending}
                    onValueChange={(networkEgress) =>
                      Alert.alert(
                        t("Change computer"),
                        t("This replaces the computer's files. Continue?"),
                        [
                          { text: t("Cancel"), style: "cancel" },
                          {
                            text: t("Continue"),
                            onPress: () =>
                              void change(() =>
                                setComputerNetwork({
                                  computerId: computer.id,
                                  networkEgress,
                                  confirmed: true,
                                }),
                              ),
                          },
                        ],
                      )
                    }
                  />
                </View>
                {!computer.supported ? (
                  <Text style={styles.secondary}>
                    {t("Network egress control is unsupported on this computer.")}
                  </Text>
                ) : null}
                {computer.pending ? <ActivityIndicator /> : null}
              </View>
            ))}
            <Text style={styles.secondary}>{t("Skills have moved to Customize")}</Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { padding: 20, gap: 16 },
    row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
    card: { padding: 16, gap: 8, backgroundColor: tokens.card, borderRadius: 12 },
    title: { color: native.label, fontSize: 16, fontWeight: "600", flexShrink: 1 },
    body: { color: native.label, fontSize: 15 },
    secondary: { color: native.secondaryLabel, fontSize: 14 },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
