import type { OllamaStatus } from "@ardurbot/contracts";
import { ollamaModelLabel } from "@ardurbot/contracts";
import { Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** Connections and installed models are read-only on mobile. */
export function OllamaConnection({ status }: { status: OllamaStatus | null }) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  return (
    <View style={{ gap: 8, paddingVertical: 16 }}>
      <Text style={{ color: tokens.foreground }}>Ollama</Text>
      {status ? (
        <>
          <Text style={{ color: tokens.mutedForeground }}>{status.baseUrl}</Text>
          {status.version ? (
            <Text style={{ color: tokens.mutedForeground }}>{status.version}</Text>
          ) : null}
          {status.issue ? (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {status.issue}
            </Text>
          ) : null}
          {!status.credentialId ? (
            <Text style={{ color: tokens.mutedForeground }}>
              {t("Connect Ollama from desktop or web.")}
            </Text>
          ) : status.version && !status.models.length ? (
            <Text style={{ color: tokens.mutedForeground }}>
              {t("No models installed. Pull one to start.")}
            </Text>
          ) : null}
          {status.models.map((model) => (
            <Text key={model.id} style={{ color: tokens.foreground }}>
              {ollamaModelLabel(model)}
            </Text>
          ))}
        </>
      ) : (
        <Text style={{ color: tokens.mutedForeground }}>{t("Loading…")}</Text>
      )}
    </View>
  );
}
