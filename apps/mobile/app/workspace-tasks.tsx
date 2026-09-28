import type { RunActivityRow, WorkspaceTasks } from "@ardurbot/contracts";
import {
  workspaceRunActive,
  workspaceRunQueued,
  workspaceSteerThread,
  workspaceStopStillPending,
  workspaceStopTarget,
  workspaceTaskBuckets,
} from "@ardurbot/core";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, ScrollView, Text, TextInput, View } from "react-native";
import { activityStatusLabel, formatActivityRelativeTime } from "../lib/activity";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export default function WorkspaceTasksScreen() {
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [snapshot, setSnapshot] = useState<WorkspaceTasks | null>(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [steering, setSteering] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const currentBot = useRef(botId);
  currentBot.current = botId;
  useEffect(() => {
    setSnapshot(null);
    setError(false);
    setStopping(new Set());
  }, [botId]);
  const refresh = useCallback(async () => {
    if (!botId) return;
    try {
      const result = await rpc<WorkspaceTasks>("workspace/tasks", { botId });
      if (currentBot.current === botId) {
        setSnapshot(result);
        setStopping(
          (current) => new Set([...current].filter((id) => workspaceStopStillPending(result, id))),
        );
        setError(false);
      }
    } catch {
      if (currentBot.current === botId) setError(true);
    }
  }, [botId]);
  useFocusEffect(
    useCallback(() => {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = async () => {
        await refresh();
        if (!stopped) timer = setTimeout(() => void tick(), 15_000);
      };
      void tick();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    }, [refresh]),
  );
  async function act(id: string, operation: () => Promise<unknown>) {
    setPending(id);
    try {
      await operation();
      await refresh();
      setSteering(null);
      setMessage("");
      return true;
    } catch {
      setError(true);
      return false;
    } finally {
      setPending(null);
    }
  }
  async function stop(id: string, operation: () => Promise<unknown>) {
    setStopping((current) => new Set(current).add(id));
    if (!(await act(id, operation)))
      setStopping((current) => new Set([...current].filter((item) => item !== id)));
  }
  function confirmStop(id: string, delegated: boolean, operation: () => Promise<unknown>) {
    Alert.alert(
      delegated ? t("Stop delegated work?") : t("Stop work in this conversation?"),
      delegated ? t("This stops the delegated task tree.") : t("This can stop more than one run."),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Stop"), style: "destructive", onPress: () => void stop(id, operation) },
      ],
    );
  }
  function open(run: RunActivityRow) {
    if (run.externalThread) return;
    if (run.groupId) {
      router.push({
        pathname: "/group-thread",
        params: { groupId: run.groupId, name: run.groupName ?? t("Group") },
      });
    } else {
      router.push({ pathname: "/thread", params: { botId: run.botId, name: run.botName } });
    }
  }
  const buckets = snapshot && botId ? workspaceTaskBuckets(snapshot, botId) : null;
  const routineNames = new Map(
    snapshot?.routines.map((routine) => [routine.id, routine.name]) ?? [],
  );
  const row = (run: WorkspaceTasks["runs"][number]) => {
    const stopTarget = workspaceStopTarget(run, botId);
    const steerThread = workspaceSteerThread(run, botId);
    return (
      <View
        key={run.runId}
        style={{
          paddingVertical: 12,
          gap: 4,
          borderBottomWidth: 1,
          borderBottomColor: tokens.border,
        }}
      >
        <Text style={{ color: tokens.foreground, fontWeight: "600" }}>
          {(run.routineId && routineNames.get(run.routineId)) || run.promptSnippet || run.botName}
        </Text>
        <Text style={{ color: tokens.mutedForeground }}>
          {run.botName} ·{" "}
          {stopping.has(run.runId) ? t("Stopping") : activityStatusLabel(run.status)} ·{" "}
          {formatActivityRelativeTime(run.startedAt ?? run.createdAt ?? run.updatedAt)}
        </Text>
        {run.externalThread ? (
          <Text style={{ color: tokens.mutedForeground }}>
            {t("Open on web or desktop to review this conversation.")}
          </Text>
        ) : (
          <Button title={t("Open conversation")} onPress={() => open(run)} />
        )}
        {workspaceRunActive(run) || workspaceRunQueued(run) ? (
          <>
            {steerThread ? (
              <Button
                title={t("Steer")}
                onPress={() => {
                  setSteering(run.runId);
                  setMessage("");
                }}
              />
            ) : null}
            {stopTarget ? (
              <Button
                title={
                  stopTarget.kind === "delegation"
                    ? t("Stop delegated work")
                    : t("Stop work in this conversation")
                }
                disabled={stopping.has(run.runId)}
                onPress={() =>
                  confirmStop(run.runId, stopTarget.kind === "delegation", () =>
                    stopTarget.kind === "delegation"
                      ? rpc("delegations/cancel", { rootTaskId: stopTarget.id })
                      : rpc("threads/stop", { threadId: stopTarget.id }),
                  )
                }
              />
            ) : null}
          </>
        ) : null}
        {steering === run.runId ? (
          <View style={{ gap: 4 }}>
            <TextInput
              accessibilityLabel={t("Steer work")}
              value={message}
              onChangeText={setMessage}
              maxLength={2000}
              multiline
              style={{
                color: tokens.foreground,
                borderColor: tokens.border,
                borderWidth: 1,
                padding: 8,
              }}
            />
            <Button
              title={t("Send follow-up")}
              disabled={!message.trim() || pending === run.runId}
              onPress={() =>
                void act(run.runId, () =>
                  rpc("threads/followUp", {
                    threadId: steerThread!,
                    text: message.trim(),
                  }),
                )
              }
            />
            <Button title={t("Cancel")} onPress={() => setSteering(null)} />
          </View>
        ) : null}
      </View>
    );
  };
  const section = (title: string, items: WorkspaceTasks["runs"]) =>
    items.length ? (
      <View style={{ gap: 2 }}>
        <Text
          accessibilityRole="header"
          style={{ color: tokens.mutedForeground, fontWeight: "600" }}
        >
          {title}
        </Text>
        {items.map((run) => row(run))}
      </View>
    ) : null;
  return (
    <ScrollView
      style={{ backgroundColor: tokens.background }}
      contentContainerStyle={{ padding: 16, gap: 16 }}
    >
      <Stack.Screen options={{ title: t("Tasks") }} />
      {error ? (
        <View>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {t("Could not refresh tasks")}
          </Text>
          <Button title={t("Retry")} onPress={() => void refresh()} />
        </View>
      ) : null}
      {!snapshot && !error ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("Loading tasks…")}</Text>
      ) : null}
      {snapshot && buckets ? (
        <>
          {!buckets.running.length && !buckets.queued.length ? (
            <Text style={{ color: tokens.mutedForeground }}>{t("Nothing running or queued")}</Text>
          ) : null}
          {section(t("Running"), buckets.running)}
          {section(t("Queued"), buckets.queued)}
          <View>
            <Text
              accessibilityRole="header"
              style={{ color: tokens.mutedForeground, fontWeight: "600" }}
            >
              {t("Delegated")}
            </Text>
            {buckets.delegatedRuns.length ? (
              buckets.delegatedRuns.map(row)
            ) : !buckets.delegations.length ? (
              <Text style={{ color: tokens.mutedForeground }}>{t("No delegated work")}</Text>
            ) : null}
            {buckets.delegations.map((item) => (
              <View key={item.id} style={{ paddingVertical: 8 }}>
                <Text style={{ color: tokens.foreground }}>
                  {item.card?.goal ?? item.actingName}
                </Text>
                <Text style={{ color: tokens.mutedForeground }}>
                  {item.actingName} ·{" "}
                  {stopping.has(item.id) || item.status === "cancel-requested"
                    ? t("Stopping")
                    : item.status}
                </Text>
                {["queued", "running", "cancel-requested"].includes(item.status) ? (
                  <Button
                    title={t("Stop delegated work")}
                    disabled={stopping.has(item.id)}
                    onPress={() =>
                      confirmStop(item.id, true, () =>
                        rpc("delegations/cancel", { rootTaskId: item.rootTaskId }),
                      )
                    }
                  />
                ) : null}
              </View>
            ))}
          </View>
          {section(t("Recent"), buckets.recent)}
        </>
      ) : null}
    </ScrollView>
  );
}
