import {
  type BotCommunicationPolicy,
  GROUP_MEMBER_MAX,
  GROUP_MEMBER_MIN,
  parseRoomPolicy,
  ROOM_POLICY_MAX_CONCURRENT_RUNS_MAX,
  ROOM_POLICY_MAX_CONCURRENT_RUNS_MIN,
  type RoomPolicyPatch,
  runtimeNames,
  runtimeSupportsTools,
} from "@ardurbot/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { BotMemberPicker } from "../components/bot-member-picker";
import { ContextSection } from "../components/context-section";
import { GroupMemberModelControl } from "../components/group-member-model-control";
import {
  type MobileBot,
  type MobileGroup,
  type MobileModel,
  type MobileModelCredential,
  rpc,
} from "../lib/api";
import { hasPairedDevice } from "../lib/dispatch";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

export default function GroupSettingsScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const router = useRouter();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const [group, setGroup] = useState<MobileGroup | null>(null);
  // The last group the drafts were reconciled against. It advances synchronously wherever the
  // group is set, so two saves that finish before a render each compare against the previous one.
  const baseline = useRef<MobileGroup | null>(null);
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [name, setName] = useState("");
  const [coordinator, setCoordinator] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(
    parseRoomPolicy(undefined).maxConcurrentRuns,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [spaceTraffic, setSpaceTraffic] = useState<BotCommunicationPolicy | null>(null);
  const [groupTraffic, setGroupTraffic] = useState<BotCommunicationPolicy | null>(null);
  const [trafficBusy, setTrafficBusy] = useState(false);
  const [pairedDevice, setPairedDevice] = useState(false);

  useEffect(() => {
    void hasPairedDevice().then(setPairedDevice);
  }, []);

  useEffect(() => {
    if (!groupId) return;
    let active = true;
    void Promise.all([
      rpc<BotCommunicationPolicy>("botComms/getPolicy", {}),
      rpc<BotCommunicationPolicy>("botComms/getPolicy", { groupId }),
    ])
      .then(([space, groupPolicy]) => {
        if (active) {
          setSpaceTraffic(space);
          setGroupTraffic(groupPolicy);
        }
      })
      .catch(() => {
        if (active) {
          setSpaceTraffic(null);
          setGroupTraffic(null);
        }
      });
    return () => {
      active = false;
    };
  }, [groupId]);

  async function setTrafficPaused(policy: BotCommunicationPolicy) {
    if (trafficBusy || !groupId || (pairedDevice && policy.paused)) return;
    setTrafficBusy(true);
    try {
      await rpc("botComms/setPaused", {
        scope: policy.scope,
        ...(policy.groupId ? { groupId: policy.groupId } : {}),
        paused: !policy.paused,
        expectedRevision: policy.revision,
      });
      const [space, groupPolicy] = await Promise.all([
        rpc<BotCommunicationPolicy>("botComms/getPolicy", {}),
        rpc<BotCommunicationPolicy>("botComms/getPolicy", { groupId }),
      ]);
      setSpaceTraffic(space);
      setGroupTraffic(groupPolicy);
    } catch {
      Alert.alert(t("Could not update team messages"));
    } finally {
      setTrafficBusy(false);
    }
  }

  useEffect(() => {
    if (!groupId) return;
    void Promise.all([
      rpc<MobileGroup[]>("groups/list").then(
        (groups) => groups.find((row) => row.id === groupId) ?? null,
      ),
      rpc<MobileBot[]>("bots/list"),
    ])
      .then(([nextGroup, nextBots]) => {
        if (!nextGroup) throw new Error(t("Group not found"));
        baseline.current = nextGroup;
        setGroup(nextGroup);
        setName(nextGroup.name);
        setCoordinator(nextGroup.coordinatorBotId ?? null);
        setSelected(nextGroup.members.map((member) => member.botId));
        setMaxConcurrentRuns(parseRoomPolicy(nextGroup.roomPolicy).maxConcurrentRuns);
        setBots(nextBots.filter((bot) => !bot.archivedAt));
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("Could not load group")));
  }, [groupId]);

  useEffect(() => {
    void Promise.all([
      rpc<MobileModel[]>("models/list"),
      rpc<MobileModelCredential[]>("models/credentials"),
    ])
      .then(([nextCatalog, nextCredentials]) => {
        setCatalog(nextCatalog);
        setCredentials(nextCredentials);
      })
      .catch(() => {
        setCatalog([]);
        setCredentials([]);
      });
  }, []);

  function onGroupSaved(refreshed: MobileGroup) {
    const base = baseline.current;
    baseline.current = refreshed;
    if (base) {
      // Functional updates compare the draft as it is now: an edit typed while the
      // request was in flight is kept, an untouched draft adopts the refreshed value.
      setName((current) => (current === base.name ? refreshed.name : current));
      const baseMemberIds = base.members.map((member) => member.botId).join(",");
      setSelected((current) =>
        current.join(",") === baseMemberIds
          ? refreshed.members.map((member) => member.botId)
          : current,
      );
      const baseCoordinator = base.coordinatorBotId ?? null;
      setCoordinator((current) =>
        current === baseCoordinator ? (refreshed.coordinatorBotId ?? null) : current,
      );
      const baseConcurrency = parseRoomPolicy(base.roomPolicy).maxConcurrentRuns;
      const refreshedConcurrency = parseRoomPolicy(refreshed.roomPolicy).maxConcurrentRuns;
      setMaxConcurrentRuns((current) =>
        current === baseConcurrency ? refreshedConcurrency : current,
      );
    }
    setGroup(refreshed);
  }

  async function save() {
    if (!groupId || !group || pending) return;
    setPending(true);
    setError(null);
    try {
      const input: {
        groupId: string;
        name?: string;
        botIds?: string[];
        coordinatorBotId?: string | null;
        roomPolicy?: RoomPolicyPatch;
      } = {
        groupId,
        coordinatorBotId: coordinator && selected.includes(coordinator) ? coordinator : null,
      };
      if (name.trim() !== group.name) input.name = name.trim();
      const memberIds = group.members.map((member) => member.botId).join(",");
      if (selected.join(",") !== memberIds) input.botIds = selected;
      if (maxConcurrentRuns !== parseRoomPolicy(group.roomPolicy).maxConcurrentRuns) {
        input.roomPolicy = { maxConcurrentRuns };
      }
      await rpc("groups/update", input);
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save group"));
    } finally {
      setPending(false);
    }
  }

  function remove() {
    if (!groupId || !group) return;
    Alert.alert(group.name, t("Delete this group? Bots and their solo threads are kept."), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete"),
        style: "destructive",
        onPress: () =>
          void rpc("groups/remove", { groupId })
            .then(() => router.replace("/"))
            .catch((err) =>
              Alert.alert(
                t("Could not delete group"),
                err instanceof Error ? err.message : t("Try again."),
              ),
            ),
      },
    ]);
  }

  const coordinatorRuntime =
    coordinator && selected.includes(coordinator)
      ? (group?.members.find((member) => member.botId === coordinator)?.effectiveRuntimePin
          ?.runtimeKind ??
        bots.find((bot) => bot.id === coordinator)?.runtimeKind ??
        "pi")
      : null;

  return (
    <>
      <Stack.Screen options={{ title: t("Group settings") }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={t("Group name")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 14,
            color: tokens.foreground,
            fontSize: 16,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, fontSize: 14, marginTop: 20 }}>
          {t("Members")}
        </Text>
        <BotMemberPicker
          bots={bots}
          selected={selected}
          onChange={setSelected}
          disabled={pending}
        />
        {group?.members
          .filter((member) => selected.includes(member.botId))
          .map((member) => {
            const bot = bots.find((item) => item.id === member.botId);
            return (
              <GroupMemberModelControl
                key={member.botId}
                groupId={group.id}
                member={member}
                catalog={catalog}
                credentials={credentials}
                bot={bot}
                botRuntimeKind={bot?.runtimeKind}
                experimental={bot?.runtimeExperimental}
                onSaved={onGroupSaved}
                onBotReloaded={(refreshed) =>
                  setBots((current) =>
                    current.map((item) => (item.id === refreshed.id ? refreshed : item)),
                  )
                }
                onError={setError}
              />
            );
          })}
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            presentMessageActionSheet({
              title: t("Coordinator"),
              cancel: t("Cancel"),
              more: t("More"),
              colorScheme,
              actions: [
                { text: t("None"), onPress: () => setCoordinator(null) },
                ...bots
                  .filter((bot) => selected.includes(bot.id))
                  .map((bot) => ({ text: bot.name, onPress: () => setCoordinator(bot.id) })),
              ],
            })
          }
        >
          <Text style={{ color: tokens.foreground }}>
            {t("Coordinator")}:{" "}
            {bots.find((bot) => bot.id === coordinator && selected.includes(bot.id))?.name ??
              t("None")}
          </Text>
        </Pressable>
        {coordinatorRuntime && !runtimeSupportsTools(coordinatorRuntime) ? (
          <Text style={{ color: tokens.warning, marginTop: 8 }}>
            {t("{runtime} can't use Ardur tools — a coordinator needs tools to hand off work.", {
              runtime: runtimeNames[coordinatorRuntime],
            })}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          style={{ marginTop: 16 }}
          onPress={() =>
            presentMessageActionSheet({
              title: t("Bots answering at once"),
              cancel: t("Cancel"),
              more: t("More"),
              colorScheme,
              actions: Array.from(
                {
                  length:
                    ROOM_POLICY_MAX_CONCURRENT_RUNS_MAX - ROOM_POLICY_MAX_CONCURRENT_RUNS_MIN + 1,
                },
                (_, index) => {
                  const value = ROOM_POLICY_MAX_CONCURRENT_RUNS_MIN + index;
                  return { text: String(value), onPress: () => setMaxConcurrentRuns(value) };
                },
              ),
            })
          }
        >
          <Text style={{ color: tokens.foreground }}>
            {t("Bots answering at once")}: {maxConcurrentRuns}
          </Text>
        </Pressable>
        {error ? <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text> : null}
        <Pressable
          onPress={() => void save()}
          disabled={
            !name.trim() ||
            selected.length < GROUP_MEMBER_MIN ||
            selected.length > GROUP_MEMBER_MAX ||
            pending
          }
          style={{
            marginTop: 24,
            backgroundColor: tokens.primary,
            opacity:
              !name.trim() ||
              selected.length < GROUP_MEMBER_MIN ||
              selected.length > GROUP_MEMBER_MAX ||
              pending
                ? 0.5
                : 1,
            borderRadius: 11,
            padding: 14,
            alignItems: "center",
          }}
        >
          <Text style={{ color: tokens.primaryForeground, fontSize: 16, fontWeight: "600" }}>
            {pending ? t("Saving…") : t("Save")}
          </Text>
        </Pressable>
        <Pressable
          onPress={remove}
          style={{
            marginTop: 16,
            borderRadius: 11,
            borderWidth: 1,
            borderColor: tokens.border,
            padding: 14,
            alignItems: "center",
          }}
        >
          <Text style={{ color: tokens.destructive, fontSize: 16 }}>{t("Delete group")}</Text>
        </Pressable>
        <Text style={{ color: tokens.mutedForeground }}>{t("Context")}</Text>
        {spaceTraffic && groupTraffic ? (
          <View style={{ marginTop: 16, gap: 8 }}>
            <Button
              title={
                spaceTraffic.paused
                  ? pairedDevice
                    ? t("Resume at home")
                    : t("Resume team messages")
                  : t("Pause team messages")
              }
              disabled={trafficBusy || (pairedDevice && spaceTraffic.paused)}
              onPress={() => void setTrafficPaused(spaceTraffic)}
            />
            <Button
              title={
                groupTraffic.paused
                  ? pairedDevice
                    ? t("Resume at home")
                    : t("Resume group messages")
                  : t("Pause group messages")
              }
              disabled={trafficBusy || (pairedDevice && groupTraffic.paused)}
              onPress={() => void setTrafficPaused(groupTraffic)}
            />
          </View>
        ) : null}
        {group?.members.map((member) => (
          <ContextSection
            key={member.botId}
            botId={member.botId}
            groupId={groupId}
            label={member.name}
            settings={false}
          />
        ))}
      </ScrollView>
    </>
  );
}
