import type {
  ComputerMode,
  NewBotComputerOptions,
  NewBotLocation,
  NewBotTeamComputer,
} from "@ardurbot/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  errorDataCode,
  ISOLATED_COMPUTER_UNAVAILABLE_CODE,
  NEW_BOT_HOST_UNAVAILABLE_CODE,
  NEW_BOT_TEAM_LOCATION_CONFLICT_CODE,
  normalizeCreateBotProfile,
} from "@ardurbot/contracts";
import { Stack, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ComputerLocationPicker } from "../components/computer-location-picker";
import { ComputerModePicker } from "../components/computer-mode-picker";
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
  const [sandboxAvailable, setSandboxAvailable] = useState(false);
  const [chosenLocation, setComputerLocation] = useState<NewBotLocation>("sandbox");
  const [team, setTeam] = useState<NewBotTeamComputer | null>(null);
  const teamComputer = computerMode === "team" ? team : null;
  const computerLocation = teamComputer?.location ?? chosenLocation;
  const sandboxConnection = teamComputer
    ? teamComputer.connectionId
      ? { connectionId: teamComputer.connectionId }
      : container?.connectionId === null
        ? container
        : null
    : container;
  const [hostAvailable, setHostAvailable] = useState(false);
  const [locationReady, setLocationReady] = useState(false);
  const [locationRevision, setLocationRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLocationReady(false);
    setContainer(null);
    setSandboxAvailable(false);
    setTeam(null);
    void rpc<NewBotComputerOptions>("computer/creationOptions")
      .then((options) => {
        if (active) {
          setComputerLocation(options.defaultLocation);
          setHostAvailable(options.hostAvailable);
          setContainer(options.container);
          setSandboxAvailable(options.sandboxAvailable);
          setTeam(options.team);
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
  const computerReady =
    locationReady && (computerLocation === "host" ? hostAvailable : sandboxAvailable);

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
    if (!name.trim() || pending || !computerReady) return;
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
        computerLocation,
        ...(computerLocation === "sandbox" && sandboxConnection
          ? { isolatedComputer: sandboxConnection }
          : {}),
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
        errorDataCode(err) === NEW_BOT_TEAM_LOCATION_CONFLICT_CODE
          ? t("Choose Only this bot to use a different location from the Team computer.")
          : errorDataCode(err) === NEW_BOT_HOST_UNAVAILABLE_CODE
            ? t("Connect the host service to choose This computer.")
            : refusal
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
          <ComputerLocationPicker
            value={computerLocation}
            onChange={setComputerLocation}
            hostAvailable={hostAvailable}
            sandboxAvailable={sandboxAvailable}
            teamLocation={teamComputer?.location}
            runtimeKind="pi"
            disabled={!locationReady || pending}
          />
          <ComputerModePicker value={computerMode} onChange={setComputerMode} />
          {computerLocation === "sandbox" && locationReady && !sandboxAvailable ? (
            <>
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
          disabled={!name.trim() || pending || !computerReady}
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
