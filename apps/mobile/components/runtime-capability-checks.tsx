import type { RuntimeCapabilityReport, RuntimeKind } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function RuntimeCapabilityChecks({ kind }: { kind: RuntimeKind }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<RuntimeCapabilityReport | null>(null);
  useEffect(() => {
    setReport(null);
    if (!open) return;
    let active = true;
    void rpc<RuntimeCapabilityReport>("runtimes/capabilities", { runtimeKind: kind })
      .then((value) => {
        if (active) setReport(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [kind, open]);
  const names = {
    streaming: t("Streaming"),
    instructions: t("Instruction delivery"),
    cancellation: t("Cancellation"),
    "tool-authorization": t("Tool authorization"),
    usage: t("Usage"),
  };
  const visible = report?.runtimeKind === kind ? report : null;
  return (
    <View style={{ marginTop: 8, gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <Text style={{ color: tokens.foreground }}>{t("Capability checks")}</Text>
      </Pressable>
      {open ? (
        visible ? (
          <View style={{ gap: 4 }}>
            <Text style={{ color: tokens.mutedForeground }}>
              {visible.adapterId} · {visible.adapterVersion} ·{" "}
              {visible.runtimeVersion ?? t("Unknown")}
            </Text>
            {visible.versionMismatch ? (
              <Text style={{ color: tokens.mutedForeground }}>
                {t("Report is for another version")}
              </Text>
            ) : null}
            {visible.checks.map((check) => (
              <Text key={check.behavior} style={{ color: tokens.mutedForeground }}>
                {names[check.behavior]}: {check.declared === true ? `${t("Declared")} · ` : ""}
                {check.verdict === "confirmed"
                  ? t("Confirmed offline")
                  : check.verdict === "unsupported"
                    ? t("Unsupported")
                    : t("Not tested")}
              </Text>
            ))}
          </View>
        ) : (
          <Text style={{ color: tokens.mutedForeground }}>{t("Not tested")}</Text>
        )
      ) : null}
    </View>
  );
}
