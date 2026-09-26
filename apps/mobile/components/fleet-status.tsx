import type { FleetTarget, HostLabel } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { mobileTargetName } from "../lib/team";

export function FleetStatus() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [targets, setTargets] = useState<FleetTarget[]>([]);
  const [hostLabel, setHostLabel] = useState<HostLabel>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void rpc<{ targets: FleetTarget[]; hostLabel?: HostLabel }>("fleet/list", {})
        .then((value) => {
          if (active) {
            setTargets(value.targets);
            setHostLabel(value.hostLabel);
            setError(false);
          }
        })
        .catch(() => {
          if (active) setError(true);
        });
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const name = (target: FleetTarget) => mobileTargetName(target, t, hostLabel);
  return (
    <View accessibilityLabel={t("Computers")} style={styles.section}>
      <Text style={{ color: tokens.foreground }}>{t("Computers")}</Text>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {t("Could not load computers.")}
        </Text>
      ) : null}
      {targets.map((target) => {
        const { memoryFree, memoryTotal, cpuCount } = target.capacity;
        const percent =
          memoryFree !== null && memoryTotal
            ? Math.min(100, (memoryFree / memoryTotal) * 100)
            : null;
        return (
          <View key={target.id} style={styles.row}>
            <Text style={{ color: tokens.foreground }}>{name(target)}</Text>
            <Text style={{ color: tokens.mutedForeground }}>
              {target.state === "connected"
                ? t("Connected")
                : target.state === "discovered"
                  ? t("Available")
                  : t("Unavailable")}
              {cpuCount !== null ? ` · ${cpuCount} CPU` : ""}
            </Text>
            <Text style={{ color: tokens.mutedForeground }}>
              {memoryFree === null
                ? t("Memory not reported")
                : t("{amount} GB free", { amount: (memoryFree / 1024 ** 3).toFixed(1) })}
            </Text>
            {percent !== null ? (
              <View
                accessibilityRole="progressbar"
                accessibilityLabel={t("Free memory")}
                accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
                style={[styles.bar, { backgroundColor: tokens.muted }]}
              >
                <View
                  style={[styles.fill, { backgroundColor: tokens.primary, width: `${percent}%` }]}
                />
              </View>
            ) : null}
            {target.bots.length ? (
              <Text style={{ color: tokens.mutedForeground }}>
                {target.bots.map((bot) => bot.name).join(", ")}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
const styles = StyleSheet.create({
  section: { padding: 16, gap: 12 },
  row: { gap: 4 },
  bar: { height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4 },
});
