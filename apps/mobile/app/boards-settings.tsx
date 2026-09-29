import type {
  ModelCatalogEntry,
  ModelCredential,
  RuntimeAvailability,
  RuntimeKind,
  SpaceLearningConfig,
} from "@ardurbot/contracts";
import {
  antigravityEffortForModel,
  nativeRuntimeProviders,
  runtimeLabels,
} from "@ardurbot/contracts";
import type { BoardConfiguration, BoardProblem, BoardWorkspace } from "@ardurbot/contracts/board";
import { spaceDefaultEffort } from "@ardurbot/core";
import { Stack, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Button,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { hasPairedDevice } from "../lib/dispatch";
import { useI18n } from "../lib/i18n";
import {
  loadLearningSettings,
  type ReviewerChoice,
  reviewerMenuOptions,
  setReviewerPin,
  thinkingMenuOptions,
} from "../lib/learning";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

const REVIEWER_PROBE_KINDS = ["claude-code", "codex-app-server", "antigravity", "hermes"] as const;
type ReviewerProbeKind = (typeof REVIEWER_PROBE_KINDS)[number];
const NATIVE_REVIEWER_KINDS = ["claude-code", "codex-app-server", "antigravity"] as const;
type NativeReviewerKind = (typeof NATIVE_REVIEWER_KINDS)[number];

function isNativeReviewerKind(kind: RuntimeKind): kind is NativeReviewerKind {
  return (NATIVE_REVIEWER_KINDS as readonly string[]).includes(kind);
}

async function loadReviewerProbes(): Promise<
  Partial<Record<ReviewerProbeKind, RuntimeAvailability | null>>
> {
  const entries = await Promise.all(
    REVIEWER_PROBE_KINDS.map(async (runtimeKind) => {
      try {
        const value = await rpc<RuntimeAvailability>("runtimes/availability", { runtimeKind });
        return [runtimeKind, value] as const;
      } catch {
        return [runtimeKind, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries) as Partial<
    Record<ReviewerProbeKind, RuntimeAvailability | null>
  >;
}

function nativeReviewerEffort(
  kind: NativeReviewerKind,
  modelId: string,
  efforts: readonly string[],
  kept: string | null | undefined,
): string | null {
  if (kind === "antigravity") {
    const expected = antigravityEffortForModel(modelId);
    return expected === undefined ? (efforts[0] ?? null) : expected;
  }
  if (kept && efforts.includes(kept)) return kept;
  return efforts[0] ?? null;
}

export default function BoardsSettings() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const router = useRouter();
  const [boards, setBoards] = useState<BoardWorkspace[]>([]);
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<BoardProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [owner, setOwner] = useState(false);
  const [upkeep, setUpkeep] = useState(true);
  const [learning, setLearning] = useState<SpaceLearningConfig | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [probes, setProbes] = useState<
    Partial<Record<ReviewerProbeKind, RuntimeAvailability | null>>
  >({});
  const [kind, setKind] = useState<RuntimeKind>("pi");
  const board = boards.find((row) => row.id === selected) ?? boards[0];
  useEffect(() => setName(board?.name ?? ""), [board?.id, board?.name]);
  async function load() {
    const [
      result,
      bots,
      upkeepResult,
      learningResult,
      catalogResult,
      credentialResult,
      nextProbes,
    ] = await Promise.all([
      rpc<{ workspaces: BoardWorkspace[]; problem: BoardProblem | null }>("board/workspaces", {}),
      rpc<{ id: string; name: string }[]>("bots/list"),
      rpc<{ enabled: boolean }>("board/upkeep", {}),
      loadLearningSettings(),
      rpc<ModelCatalogEntry[]>("models/list"),
      rpc<ModelCredential[]>("models/credentials"),
      loadReviewerProbes(),
    ]);
    setBoards(result.workspaces);
    setBots(bots);
    setProblem(result.problem);
    setUpkeep(upkeepResult.enabled);
    setLearning(learningResult);
    setCatalog(catalogResult);
    setCredentials(credentialResult);
    setProbes(nextProbes);
    setKind(learningResult.reviewerPin?.runtimeKind ?? "pi");
    setLoaded(true);
  }
  async function bootstrap() {
    setBusy(true);
    setLoaded(false);
    setOwner(false);
    setError(false);
    try {
      if (await hasPairedDevice()) {
        setLoaded(true);
        return;
      }
      const me = await rpc<{ isDeploymentOwner: boolean }>("me");
      setOwner(me.isDeploymentOwner);
      if (me.isDeploymentOwner) await load();
      else setLoaded(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void bootstrap();
  }, []);
  async function work(action: () => Promise<unknown>) {
    if (busy || !owner) return;
    setBusy(true);
    setError(false);
    try {
      await action();
      await load();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  const configure = (patch: BoardConfiguration) =>
    board &&
    work(() =>
      rpc("board/configure", {
        workspaceId: board.id,
        patch: {
          ...patch,
          ...(patch.allowedBotIds
            ? {
                allowedBotIds: patch.allowedBotIds.filter((id) =>
                  bots.some((bot) => bot.id === id),
                ),
              }
            : {}),
        },
      }),
    );
  const foreground = { color: tokens.foreground };
  return (
    <ScrollView
      style={{ backgroundColor: tokens.background }}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: t("Boards") }} />
      {!loaded && !error ? <ActivityIndicator /> : null}
      {error || problem ? (
        <View>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {t("Could not load Board; retry.")}
          </Text>
          <Button title={t("Retry")} disabled={busy} onPress={() => void bootstrap()} />
        </View>
      ) : null}
      {loaded && !owner ? (
        <Text style={foreground}>{t("Sign in as the owner to configure boards.")}</Text>
      ) : null}
      {owner && loaded ? (
        <>
          <Text style={[styles.heading, foreground]}>
            {t("Bots keep the board and memory current")}
          </Text>
          <Switch
            accessibilityLabel={t("Bots keep the board and memory current")}
            value={upkeep}
            disabled={busy}
            onValueChange={(enabled) =>
              void work(async () => {
                const saved = await rpc<{ enabled: boolean }>("board/setUpkeep", { enabled });
                setUpkeep(saved.enabled);
              })
            }
          />
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              marginVertical: 8,
            }}
          >
            <Text style={foreground}>{t("Learning review")}</Text>
            <Switch
              accessibilityLabel={t("Learning review")}
              value={learning?.enabled ?? false}
              disabled={busy || !learning?.canConfigure}
              onValueChange={(enabled) =>
                learning
                  ? void work(async () => {
                      setLearning(
                        await rpc<SpaceLearningConfig>("learning/configure", {
                          enabled,
                          reviewerPin: learning.reviewerPin,
                          consolidationEnabled: learning.consolidationEnabled,
                          budgets: learning.budgets,
                        }),
                      );
                    })
                  : undefined
              }
            />
          </View>
          <Text style={foreground}>
            {t("Reviews use this connection and may incur model charges.")}
          </Text>
          <Button
            title={t(runtimeLabels[kind])}
            disabled={busy || !learning?.canConfigure}
            onPress={() =>
              presentMessageActionSheet({
                title: t("Runs on"),
                cancel: t("Cancel"),
                more: t("More"),
                colorScheme,
                actions: (Object.keys(runtimeLabels) as RuntimeKind[]).map((value) => ({
                  text: t(runtimeLabels[value]),
                  onPress: () => setKind(value),
                })),
              })
            }
          />
          <Button
            title={(() => {
              const shown =
                learning?.reviewerPin?.runtimeKind === kind
                  ? learning.reviewerPin
                  : kind === "pi"
                    ? learning?.destination
                    : null;
              return shown?.modelId
                ? t("Reviewer: {model}", { model: shown.modelId })
                : t("Choose a model");
            })()}
            disabled={busy || !learning?.canConfigure}
            onPress={() => {
              if (!learning) return;
              const sheet = {
                cancel: t("Cancel"),
                more: t("More"),
                colorScheme,
              };
              const expectedRevision = learning.reviewerPin?.revision ?? 0;
              if (isNativeReviewerKind(kind)) {
                const models = probes[kind]?.models ?? [];
                if (models.length === 0) {
                  router.push("/models");
                  return;
                }
                presentMessageActionSheet({
                  ...sheet,
                  title: t("Learning reviewer"),
                  actions: models.map((entry) => ({
                    text: entry.label,
                    onPress: () => {
                      const previous =
                        learning.reviewerPin?.runtimeKind === kind ? learning.reviewerPin : null;
                      void work(async () => {
                        setLearning(
                          await setReviewerPin(expectedRevision, {
                            runtimeKind: kind,
                            provider: nativeRuntimeProviders[kind],
                            modelId: entry.id,
                            credentialId: `native:${kind}`,
                            effort: nativeReviewerEffort(
                              kind,
                              entry.id,
                              entry.efforts,
                              previous?.effort,
                            ),
                          }),
                        );
                      });
                    },
                  })),
                });
                return;
              }
              const runtimeKind = kind === "hermes" ? "hermes" : "pi";
              const actions = reviewerMenuOptions(
                catalog,
                credentials,
                t,
                (pin) => {
                  const entry = catalog.find(
                    (item) => item.provider === pin.provider && item.id === pin.modelId,
                  );
                  const previous =
                    learning.reviewerPin?.runtimeKind === runtimeKind ? learning.reviewerPin : null;
                  const effortLevels = entry?.thinkingLevels ?? [];
                  const effort =
                    previous?.effort &&
                    effortLevels.includes(previous.effort as (typeof effortLevels)[number])
                      ? previous.effort
                      : spaceDefaultEffort(undefined, effortLevels);
                  void work(async () => {
                    setLearning(await setReviewerPin(expectedRevision, { ...pin, effort }));
                  });
                },
                runtimeKind,
                () => router.push("/models"),
              );
              if (actions.length === 1 && actions[0]?.text === t("Connect a model")) {
                router.push("/models");
                return;
              }
              presentMessageActionSheet({
                ...sheet,
                title: t("Learning reviewer"),
                actions,
              });
            }}
          />
          {(() => {
            const pin =
              learning?.reviewerPin?.runtimeKind === kind
                ? learning.reviewerPin
                : kind === "pi"
                  ? learning?.destination
                  : null;
            if (!pin) return null;
            const entry = catalog.find(
              (item) => item.provider === pin.provider && item.id === pin.modelId,
            );
            const effortLevels = entry?.thinkingLevels ?? [];
            if (effortLevels.length === 0 || isNativeReviewerKind(kind)) return null;
            return (
              <Button
                title={t("Thinking: {level}", { level: pin.effort ?? "medium" })}
                disabled={busy || !learning?.canConfigure}
                onPress={() => {
                  presentMessageActionSheet({
                    title: t("Thinking"),
                    cancel: t("Cancel"),
                    more: t("More"),
                    colorScheme,
                    actions: thinkingMenuOptions(
                      effortLevels,
                      pin.provider === "ollama" || pin.provider === "local",
                      t,
                      (effort) => {
                        void work(async () => {
                          const expectedRevision = learning?.reviewerPin?.revision ?? 0;
                          setLearning(
                            await setReviewerPin(expectedRevision, {
                              ...pin,
                              effort,
                            } as ReviewerChoice),
                          );
                        });
                      },
                    ),
                  });
                }}
              />
            );
          })()}
          <Text style={[styles.heading, foreground]}>{t("Beads")}</Text>
          <Text style={foreground}>
            {problem?.code === "not_installed"
              ? t("Beads is not installed on this computer")
              : problem
                ? t("Not connected")
                : t("Connected")}
          </Text>
          <Button title={t("Refresh")} disabled={busy} onPress={() => void work(load)} />
          <Text style={[styles.heading, foreground]}>{t("Registered folders")}</Text>
          {boards.map((row) => (
            <Button
              key={row.id}
              title={`${row.name}${row.enabled ? "" : ` · ${t("Archived")}`}`}
              disabled={row.id === board?.id}
              onPress={() => setSelected(row.id)}
            />
          ))}
          {board ? (
            <>
              <Text style={[styles.heading, foreground]}>
                {board.kind === "space" ? t("Space board") : t("Folder board")}
              </Text>
              <TextInput
                accessibilityLabel={t("Name")}
                style={[styles.input, foreground, { borderColor: tokens.border }]}
                value={name}
                maxLength={100}
                onChangeText={setName}
              />
              <Button
                title={t("Save")}
                disabled={busy || !name.trim()}
                onPress={() => void configure({ name: name.trim() })}
              />
              <Text style={foreground}>
                {!board.enabled
                  ? t("Archived")
                  : board.initialized
                    ? t("Ready")
                    : t("Not initialized")}
              </Text>
              {board.kind === "folder" ? (
                <Text style={{ color: tokens.mutedForeground }}>{board.path}</Text>
              ) : null}
              {board.enabled && !board.initialized ? (
                <Button
                  title={t("Start board")}
                  disabled={busy}
                  onPress={() =>
                    Alert.alert(
                      t("Start board?"),
                      t("Creates .beads/ in this folder. Git files and hooks stay unchanged."),
                      [
                        { text: t("Cancel"), style: "cancel" },
                        {
                          text: t("Confirm"),
                          onPress: () =>
                            void work(() => rpc("board/start", { workspaceId: board.id })),
                        },
                      ],
                    )
                  }
                />
              ) : null}
              <Button
                title={board.isDefault ? t("Default board") : t("Make default")}
                disabled={busy || board.isDefault || !board.enabled || !board.initialized}
                onPress={() => void configure({ isDefault: true })}
              />
              <View style={styles.row}>
                <Text style={foreground}>{t("All bots")}</Text>
                <Switch
                  accessibilityLabel={t("All bots")}
                  value={board.allowAllBots}
                  disabled={busy}
                  onValueChange={(value) => void configure({ allowAllBots: value })}
                />
              </View>
              {!board.allowAllBots ? (
                <>
                  <Text style={[styles.heading, foreground]}>{t("Allowed bots")}</Text>
                  {bots.map((bot) => (
                    <View key={bot.id} style={styles.row}>
                      <Text style={foreground}>{bot.name}</Text>
                      <Switch
                        accessibilityLabel={bot.name}
                        value={board.allowedBotIds.includes(bot.id)}
                        disabled={busy}
                        onValueChange={(value) =>
                          void configure({
                            allowedBotIds: value
                              ? [...board.allowedBotIds, bot.id]
                              : board.allowedBotIds.filter((id) => id !== bot.id),
                          })
                        }
                      />
                    </View>
                  ))}
                </>
              ) : null}
              {board.enabled ? (
                <Button
                  title={t("Archive board")}
                  disabled={busy}
                  onPress={() =>
                    Alert.alert(t("Archive board?"), t("Board files will be kept."), [
                      { text: t("Cancel"), style: "cancel" },
                      {
                        text: t("Archive"),
                        style: "destructive",
                        onPress: () => void configure({ enabled: false }),
                      },
                    ])
                  }
                />
              ) : (
                <Button
                  title={t("Restore")}
                  disabled={busy}
                  onPress={() => void configure({ enabled: true })}
                />
              )}
            </>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  page: { padding: 16, gap: 12 },
  heading: { fontSize: 17, fontWeight: "600" },
  input: { borderWidth: 1, borderRadius: 8, padding: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
});
