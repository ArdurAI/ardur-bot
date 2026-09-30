import type { ComputerMode } from "@ardurbot/contracts";
import { computerModeFacts } from "@ardurbot/contracts";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function ComputerModePicker({
  value,
  onChange,
  disabled = false,
  showConsequence = true,
}: {
  value: ComputerMode | undefined;
  onChange: (mode: ComputerMode) => void;
  disabled?: boolean;
  showConsequence?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { sharingWarning } = computerModeFacts(value ?? "team");
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={{ color: tokens.mutedForeground, marginBottom: 8, fontSize: 14 }}>
        {t("Sharing")}
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(["team", "dedicated"] as const).map((mode) => (
          <Pressable
            key={mode}
            accessibilityRole="button"
            accessibilityState={{ selected: value === mode }}
            disabled={disabled}
            onPress={() => onChange(mode)}
            style={{
              flex: 1,
              alignItems: "center",
              borderWidth: 1,
              borderColor: value === mode ? tokens.mutedForeground : tokens.border,
              backgroundColor: value === mode ? tokens.muted : "transparent",
              borderRadius: 11,
              paddingVertical: 12,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <Text style={{ color: value === mode ? tokens.foreground : tokens.mutedForeground }}>
              {mode === "team" ? t("Shared with team") : t("Only this bot")}
            </Text>
          </Pressable>
        ))}
      </View>
      {showConsequence && sharingWarning ? (
        <Text style={{ color: tokens.mutedForeground, marginTop: 8 }}>{t(sharingWarning)}</Text>
      ) : null}
    </View>
  );
}
