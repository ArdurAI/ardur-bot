import { nativeRuntimeProviders, runtimeNames } from "@ardurbot/contracts";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { RuntimeSettings } from "./runtime-settings";

const unchanged = () => undefined;

export function NativeRuntimeSettings() {
  const [expanded, setExpanded] = useState(false);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text style={{ color: tokens.foreground }}>{t("Native runtimes")}</Text>
      </Pressable>
      {expanded ? (
        <>
          <Text style={{ color: tokens.mutedForeground }}>{t("Set up on the home device")}</Text>
          {(Object.keys(nativeRuntimeProviders) as (keyof typeof nativeRuntimeProviders)[]).map(
            (kind) => (
              <View key={kind}>
                <Text style={{ color: tokens.foreground }}>{runtimeNames[kind]}</Text>
                <RuntimeSettings
                  kind={kind}
                  setupOnly
                  allowConnect={false}
                  experimental={false}
                  onExperimental={unchanged}
                  onKind={unchanged}
                  modelKey=""
                  onModel={unchanged}
                  effort=""
                  onEffort={unchanged}
                />
              </View>
            ),
          )}
        </>
      ) : null}
    </View>
  );
}
