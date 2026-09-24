import type { NotificationCategory, UserPreferences } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { Button, StyleSheet, Switch, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import {
  availableNotificationCategories,
  loadNotificationPreferences,
  updateNotificationPreference,
} from "../lib/notification-preferences";
import { hasPushDelivery, registerPushToken } from "../lib/push";

export function NotificationPreferences({ live }: { live: boolean }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [supported, setSupported] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const categories = availableNotificationCategories(hasPushDelivery(), live);
  useEffect(() => {
    let active = true;
    void loadNotificationPreferences()
      .then((value) => {
        if (active) {
          setPreferences(value);
          setSupported(value !== null);
          setError(false);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  if (!supported || !categories.length) return null;
  const labels = {
    responseCompletions: t("Response completions"),
    routines: t("Routines"),
    approvalsNeeded: t("Approvals needed"),
    dispatchMessages: t("Dispatch messages"),
  };
  async function update(key: NotificationCategory, value: boolean) {
    setBusy(true);
    setError(false);
    try {
      if (
        value &&
        (key === "dispatchMessages" || !live) &&
        hasPushDelivery() &&
        !(await registerPushToken())
      )
        throw new Error("permission");
      setPreferences(await updateNotificationPreference(key, value));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={styles.group} accessibilityLabel={t("Notifications")}>
      <Text style={styles.title}>{t("Notifications")}</Text>
      {error ? (
        <View>
          <Text accessibilityRole="alert" style={styles.error}>
            {t("Could not update notifications. Check permissions and try again.")}
          </Text>
          {!preferences ? (
            <Button title={t("Retry")} onPress={() => setAttempt((value) => value + 1)} />
          ) : null}
        </View>
      ) : null}
      {categories.map((key) => (
        <View key={key} style={styles.row}>
          <Text style={styles.label}>{labels[key]}</Text>
          <Switch
            accessibilityLabel={labels[key]}
            disabled={busy || !preferences}
            value={preferences?.notifications[key] ?? false}
            onValueChange={(value) => void update(key, value)}
          />
        </View>
      ))}
    </View>
  );
}
function createStyles() {
  return StyleSheet.create({
    group: { borderRadius: 16, backgroundColor: native.fill, padding: 18, gap: 12 },
    row: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    title: { color: native.label, fontSize: 17, fontWeight: "600" },
    label: { color: native.label, fontSize: 16, flex: 1 },
    error: { color: mobileTokens().destructive, fontSize: 14 },
  });
}
