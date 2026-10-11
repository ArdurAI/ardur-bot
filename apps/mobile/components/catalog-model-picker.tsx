import type { ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";
import type { ModelConnectionChoice } from "@ardurbot/core";
import { catalogModelChoices, searchCatalogModels } from "@ardurbot/core";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";

export function CatalogModelPicker({
  catalog,
  credentials,
  provider,
  modelId,
  credentialId,
  onChange,
  disabled = false,
}: {
  catalog: ModelCatalogEntry[];
  credentials: ModelCredential[];
  provider: string;
  modelId: string;
  credentialId?: string;
  disabled?: boolean;
  onChange: (choice: ModelConnectionChoice | null) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(40);
  const models = useMemo(() => catalogModelChoices(catalog, credentials), [catalog, credentials]);
  const visible = searchCatalogModels(models, query);
  function connectionLabel(choice: ModelConnectionChoice) {
    const name = choice.credential?.label ?? choice.entry.providerName ?? choice.entry.provider;
    const status =
      choice.requirement === "ready"
        ? t("Ready")
        : choice.requirement === "local-server"
          ? t("Local server")
          : choice.requirement === "sign-in"
            ? t("Sign in")
            : choice.requirement === "unavailable"
              ? t("Unavailable")
              : t("API key");
    return `${name} · ${status}`;
  }
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        accessibilityLabel={t("Search models")}
        placeholder={t("Search models")}
        placeholderTextColor={native.secondaryLabel}
        value={query}
        onChangeText={(value) => {
          setQuery(value);
          setVisibleCount(40);
        }}
        editable={!disabled}
        autoCorrect={false}
        style={{ color: native.label, backgroundColor: native.fill, padding: 12, borderRadius: 12 }}
      />
      {visible.slice(0, visibleCount).map((model) => (
        <Pressable
          key={model.key}
          accessibilityRole="radio"
          accessibilityState={{
            selected: model.connections.some(
              (choice) =>
                choice.entry.provider === provider &&
                choice.entry.id === modelId &&
                (!credentialId || choice.credential?.id === credentialId),
            ),
          }}
          disabled={
            disabled || model.connections.every((choice) => choice.requirement === "unavailable")
          }
          onPress={() => {
            if (model.connections.length === 1) {
              onChange(model.connections[0]!);
              return;
            }
            onChange(null);
            presentMessageActionSheet({
              title: t("Choose connection"),
              cancel: t("Cancel"),
              more: t("More"),
              colorScheme,
              actions: model.connections
                .filter((choice) => choice.requirement !== "unavailable")
                .map((choice) => ({
                  text: connectionLabel(choice),
                  onPress: () => onChange(choice),
                })),
            });
          }}
          style={{ backgroundColor: native.fill, padding: 12, borderRadius: 12 }}
        >
          <Text style={{ color: tokens.foreground }}>{model.label}</Text>
          <Text style={{ color: tokens.mutedForeground }}>
            {model.ready ? t("Ready") : model.connections.map(connectionLabel).join(" · ")}
          </Text>
        </Pressable>
      ))}
      {visible.length > visibleCount ? (
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={() => setVisibleCount((count) => count + 40)}
        >
          <Text style={{ color: tokens.foreground }}>{t("Show more")}</Text>
        </Pressable>
      ) : null}
      {!visible.length ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("No matching models")}</Text>
      ) : null}
    </View>
  );
}
