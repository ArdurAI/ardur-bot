import type { ComputerStatus } from "@ardurbot/contracts";
import { currentComputerLimits } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function ComputerLimitsDetails({ bot }: { bot: { id: string; name: string } }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!open) return;
    let active = true;
    const refresh = () =>
      void rpc<ComputerStatus>("computer/status", { botId: bot.id, includeLimits: true })
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => {
          if (active) setStatus(null);
        });
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [bot.id, open]);
  const limits = currentComputerLimits(status?.appliedLimits);
  const text = { color: tokens.mutedForeground };
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <Text style={text}>{bot.name}</Text>
      </Pressable>
      {open ? (
        status?.executionBoundary === "host-account" ? (
          <Text style={text}>{t("Host account")}</Text>
        ) : (
          <>
            <Text style={text}>{t("Applied limits")}</Text>
            <Text style={text}>
              {t("CPU")}: {limits?.cpuCores ?? t("Not reported")}
            </Text>
            <Text style={text}>
              {t("Memory")}:{" "}
              {limits?.memoryBytes
                ? `${(limits.memoryBytes / 1024 ** 2).toLocaleString()} MiB`
                : t("Not reported")}
            </Text>
            <Text style={text}>
              {t("Processes")}: {limits?.processes ?? t("Not reported")}
            </Text>
            {limits ? (
              <Text style={text}>
                {t("Checked {time}", { time: new Date(limits.observedAt).toLocaleTimeString() })}
              </Text>
            ) : null}
          </>
        )
      ) : null}
    </View>
  );
}
