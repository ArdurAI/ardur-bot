import type { ComputerConnectionSettings, ComputerMode, Me } from "@ardurbot/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  errorDataCode,
  ISOLATED_COMPUTER_UNAVAILABLE_CODE,
  normalizeCreateBotProfile,
  recommendedContainer,
} from "@ardurbot/contracts";
import { Stack, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { RuntimeBoundary } from "../components/runtime-summary";
import type { MobileBot } from "../lib/api";
import { rpc } from "../lib/api";
import { allowFocusPrompt, scheduleFocusPrompt } from "../lib/focus-prompt";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export default function NewBot() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("dedicated");
  const [container, setContainer] = useState<{ connectionId: string | null } | null>(null);
  const [containerName, setContainerName] = useState("");
  const [locationReady, setLocationReady] = useState(false);
  const [locationRevision, setLocationRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLocationReady(false);
    setContainer(null);
    void Promise.all([
      rpc<Me>("me"),
      rpc<{ id: string; name: string; settings: ComputerConnectionSettings }[]>(
        "computer/connections",
        {},
      ),
    ])
      .then(([me, connections]) => {
        if (active) {
          const recommendation = recommendedContainer(me.sandboxProvider, connections);
          setContainer(recommendation);
          setContainerName(
            connections.find((entry) => entry.id === recommendation?.connectionId)?.name ??
              me.sandboxProvider,
          );
          setLocationReady(true);
        }
      })
      .catch(() => {
        if (active) setLocationReady(true);
      });
    return () => {
      active = false;
    };
  }, [locationRevision]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function close() {
    if (router.canDismiss()) {
      router.dismiss();
      return;
    }
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/");
  }

  async function create() {
    if (!name.trim() || pending || !locationReady || !container) return;
    setPending(true);
    setError(null);
    try {
      // Failed list is unknown — delay focus rather than treating the bot as first.
      const existing = await rpc<MobileBot[]>("bots/list").catch(() => null);
      const isFirstBot = existing !== null && existing.length === 0;
      const bot = await rpc<MobileBot>("bots/create", {
        ...normalizeCreateBotProfile({ name, title, description }),
        notifyOnFinish: true,
        computerMode,
        ...(computerMode === "dedicated" ? { isolatedComputer: container } : {}),
      });
      allowFocusPrompt(bot.id);
      router.replace({ pathname: "/thread", params: { botId: bot.id, name: bot.name } });
      void (async () => {
        const started = await rpc("onboarding/start", { botId: bot.id })
          .then(() => true)
          .catch(() => false);
        if (!started) return;
        scheduleFocusPrompt(bot.id, isFirstBot);
      })();
    } catch (err) {
      const refusal = errorDataCode(err) === ISOLATED_COMPUTER_UNAVAILABLE_CODE;
      setError(
        refusal
          ? t("Set up a container for isolated work.")
          : err instanceof Error
            ? err.message
            : t("Could not create bot"),
      );
      if (refusal) setLocationRevision((value) => value + 1);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Pressable
              onPress={close}
              hitSlop={8}
              style={{ paddingEnd: 20, paddingVertical: 8 }}
              accessibilityRole="button"
              accessibilityLabel={t("Cancel")}
            >
              <Text style={{ color: tokens.foreground, fontSize: 17 }}>{t("Cancel")}</Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChangeText={setName}
          placeholder={t("Name this bot")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Title")}
        </Text>
        <TextInput
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChangeText={setTitle}
          placeholder={t("Describe what this bot does")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Description")}
        </Text>
        <TextInput
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChangeText={setDescription}
          placeholder={t("What this bot is for")}
          placeholderTextColor={tokens.mutedForeground}
          multiline
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
            minHeight: 120,
            textAlignVertical: "top",
          }}
        />
        <View style={{ marginTop: 16, gap: 8 }}>
          <Text style={{ color: tokens.foreground, fontWeight: "600" }}>
            {t("Where this bot runs")}
          </Text>
          {container && computerMode === "dedicated" ? (
            <RuntimeBoundary kind="docker" locationName={containerName} />
          ) : null}
          <ComputerModePicker value={computerMode} onChange={setComputerMode} />
          {locationReady && !container ? (
            <>
              <Text style={{ color: tokens.mutedForeground }}>
                {t("Set up a container for isolated work.")}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  Alert.alert(
                    t("Set up computer"),
                    t("Set up a container on desktop, then try again."),
                  )
                }
              >
                <Text style={{ color: tokens.foreground }}>{t("Set up computer")}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => setLocationRevision((value) => value + 1)}
              >
                <Text style={{ color: tokens.foreground }}>{t("Retry")}</Text>
              </Pressable>
            </>
          ) : null}
        </View>
        {error ? <Text style={{ color: tokens.destructive, marginTop: 16 }}>{error}</Text> : null}
        <Pressable
          onPress={() => void create()}
          disabled={!name.trim() || pending || !locationReady || !container}
          style={{
            marginTop: 24,
            backgroundColor: tokens.primary,
            borderRadius: 11,
            padding: 16,
            alignItems: "center",
            opacity: !name.trim() || pending ? 0.4 : 1,
          }}
        >
          <Text style={{ color: tokens.primaryForeground, fontSize: 16 }}>
            {pending ? t("Creating…") : t("Create")}
          </Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
