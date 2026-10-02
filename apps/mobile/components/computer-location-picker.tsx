import type { NewBotLocation, RuntimeKind } from "@ardurbot/contracts";
import {
  COMPUTER_BOUNDARY_MESSAGES,
  runtimeNames,
  runtimeSupportsLocation,
} from "@ardurbot/contracts";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function ComputerLocationPicker({
  value,
  onChange,
  hostAvailable,
  sandboxAvailable,
  teamLocation,
  runtimeKind = "pi",
  disabled = false,
}: {
  value: NewBotLocation;
  onChange: (location: NewBotLocation) => void;
  hostAvailable: boolean;
  sandboxAvailable: boolean;
  teamLocation?: NewBotLocation;
  runtimeKind?: RuntimeKind;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const runtime = runtimeNames[runtimeKind];
  const supportsSandbox = runtimeSupportsLocation(runtimeKind, { kind: "docker" });
  return (
    <View testID="computer-location-picker" style={styles.row}>
      {(["host", "sandbox"] as const).map((location) => {
        const reason =
          teamLocation && location !== teamLocation
            ? "Choose Only this bot to use a different location from the Team computer."
            : location === "host"
              ? !hostAvailable
                ? "Connect the host service to choose This computer."
                : null
              : !supportsSandbox
                ? "Other locations are unavailable for {runtime}. Choose This computer."
                : !sandboxAvailable
                  ? "Set up a container for isolated work."
                  : null;
        return (
          <View key={location} style={styles.option}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(location === "host" ? "This computer" : "Sandbox")}
              accessibilityState={{
                selected: value === location,
                disabled: disabled || Boolean(reason),
              }}
              disabled={disabled || Boolean(reason)}
              onPress={() => onChange(location)}
              style={[
                styles.button,
                {
                  borderColor: value === location ? tokens.foreground : tokens.border,
                  backgroundColor: value === location ? tokens.muted : "transparent",
                },
              ]}
            >
              <Text style={{ color: tokens.foreground, fontWeight: "600" }}>
                {t(location === "host" ? "This computer" : "Sandbox")}
              </Text>
              <Text style={{ color: tokens.mutedForeground }}>
                {t(COMPUTER_BOUNDARY_MESSAGES[location === "host" ? "host" : "container"])}
              </Text>
            </Pressable>
            {reason ? (
              <Text style={{ color: tokens.mutedForeground }}>{t(reason, { runtime })}</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  option: { flex: 1, gap: 8 },
  button: { flex: 1, borderWidth: 1, borderRadius: 11, padding: 12, gap: 8 },
});
