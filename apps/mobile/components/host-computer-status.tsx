import type { HostStatus } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** Mobile can inspect the host; local grants are managed on desktop. */
export function HostComputerStatus() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [status, setStatus] = useState<HostStatus | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void rpc<HostStatus>("host/status", {})
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  if (!status) return null;
  const versions = [
    status.health?.claude.version ? `claude ${status.health.claude.version}` : "",
    status.health?.codex.version ? `codex ${status.health.codex.version}` : "",
  ].filter(Boolean);
  return (
    <View accessibilityLabel={t("This computer")} style={{ gap: 8, padding: 16 }}>
      <Text style={{ color: tokens.foreground }}>{t("This computer")}</Text>
      <Text style={{ color: tokens.mutedForeground }}>
        {t("Host service:")}{" "}
        {status.connected
          ? t("Connected")
          : status.configured
            ? t("Not running — open the desktop app")
            : t("Not set up")}
        {status.connected && versions.length ? ` · ${versions.join(" · ")}` : ""}
      </Text>
      {status.roots.map((root) => (
        <Text key={root} style={{ color: tokens.mutedForeground }}>
          {root}
        </Text>
      ))}
    </View>
  );
}
