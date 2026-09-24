import type { ModelOAuthBegin, RuntimeAvailability, RuntimeKind } from "@ardurbot/contracts";
import { runtimeLabels } from "@ardurbot/contracts";
import { modelPinOptionKey, parseModelPinOptionKey } from "@ardurbot/core";
import { useEffect, useState } from "react";
import { Linking, Pressable, Switch, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

export function RuntimeSettings({
  kind,
  onKind,
  modelKey,
  onModel,
  effort,
  onEffort,
  experimental,
  onExperimental,
}: {
  experimental: boolean;
  onExperimental: (enabled: boolean) => void;
  kind: RuntimeKind;
  onKind: (kind: RuntimeKind) => void;
  modelKey: string;
  onModel: (key: string) => void;
  effort: string;
  onEffort: (effort: string) => void;
}) {
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const sheet = { colorScheme, cancel: t("Cancel"), more: t("More") };
  const [availability, setAvailability] = useState<RuntimeAvailability | null>(null);
  const [login, setLogin] = useState<ModelOAuthBegin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setAvailability(null);
    setError(null);
    if (kind === "pi") return;
    let active = true;
    void rpc<RuntimeAvailability>("runtimes/availability", { runtimeKind: kind })
      .then((value) => {
        if (active) setAvailability(value);
      })
      .catch(() => {
        if (active) setError(t("Runtime availability could not be checked."));
      });
    return () => {
      active = false;
    };
  }, [kind, refresh]);
  useEffect(() => {
    if (!login) return;
    const timer = setInterval(() => {
      void rpc<{ status: string; error?: string }>("runtimes/connectStatus", {
        loginId: login.loginId,
      })
        .then((result) => {
          if (result.status === "ready") {
            setLogin(null);
            setRefresh((value) => value + 1);
          }
          if (result.status === "error") {
            setError(result.error ?? t("Codex sign-in did not finish."));
            setLogin(null);
          }
        })
        .catch(() => {
          setError(t("Sign-in expired. Connect Codex again."));
          setLogin(null);
        });
    }, 1_000);
    return () => {
      clearInterval(timer);
      void rpc("runtimes/cancelConnect", { loginId: login.loginId }).catch(() => undefined);
    };
  }, [login]);
  const model = availability?.models.find(
    (entry) => entry.id === parseModelPinOptionKey(modelKey)?.modelId,
  );
  const button = { borderWidth: 1, borderColor: tokens.border, borderRadius: 11, padding: 12 };
  return (
    <View style={{ gap: 8, marginTop: 16 }}>
      <Text style={{ color: tokens.mutedForeground }}>{t("Runs on")}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Runs on")}
        style={button}
        onPress={() =>
          presentMessageActionSheet({
            ...sheet,
            title: t("Runs on"),
            actions: (Object.keys(runtimeLabels) as RuntimeKind[]).map((value) => ({
              text: t(runtimeLabels[value]),
              onPress: () => {
                onKind(value);
                onExperimental(false);
                onModel("");
                onEffort("");
                setLogin(null);
                setError(null);
              },
            })),
          })
        }
      >
        <Text style={{ color: tokens.foreground }}>{t(runtimeLabels[kind])}</Text>
      </Pressable>
      {kind !== "pi" ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={{ color: tokens.foreground }}>{t("Experimental")}</Text>
            <Switch
              accessibilityLabel={t("Experimental")}
              value={experimental}
              onValueChange={onExperimental}
            />
          </View>
          {availability?.reason ? (
            <Text accessibilityRole="text" style={{ color: tokens.mutedForeground }}>
              {availability.reason}
            </Text>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {error}
            </Text>
          ) : null}
          <Pressable accessibilityRole="button" onPress={() => setRefresh((value) => value + 1)}>
            <Text style={{ color: tokens.foreground }}>{t("Check again")}</Text>
          </Pressable>
          {kind === "codex-app-server" && !availability?.available ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void rpc<ModelOAuthBegin>("runtimes/connectCodex")
                  .then(setLogin)
                  .catch(() => setError(t("Codex app-server unavailable")));
              }}
            >
              <Text style={{ color: tokens.foreground }}>{t("Connect")}</Text>
            </Pressable>
          ) : null}
          {login ? (
            <Pressable
              accessibilityRole="link"
              style={button}
              onPress={() => void Linking.openURL(login.verificationUri)}
            >
              <Text style={{ color: tokens.foreground }}>{t("Continue with ChatGPT")}</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Model")}
            style={button}
            onPress={() =>
              presentMessageActionSheet({
                ...sheet,
                title: t("Model"),
                actions: (availability?.models ?? []).map((entry) => ({
                  text: entry.label,
                  onPress: () => {
                    onModel(
                      modelPinOptionKey(
                        kind === "claude-code" ? "anthropic" : "openai-codex",
                        entry.id,
                        `native:${kind}`,
                      ),
                    );
                    onEffort("");
                  },
                })),
              })
            }
          >
            <Text style={{ color: tokens.foreground }}>
              {model?.label ?? parseModelPinOptionKey(modelKey)?.modelId ?? t("Choose a model")}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Thinking")}
            style={button}
            onPress={() =>
              presentMessageActionSheet({
                ...sheet,
                title: t("Thinking"),
                actions: (model?.efforts ?? []).map((value) => ({
                  text: value,
                  onPress: () => onEffort(value),
                })),
              })
            }
          >
            <Text style={{ color: tokens.foreground }}>{effort || t("Choose effort")}</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}
