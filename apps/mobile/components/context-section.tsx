import type { Brief, ContextSnapshot } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { loadContext } from "../lib/context";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

const milliseconds = (value?: number | null) => (value == null ? "—" : `${Math.round(value)} ms`);
export function MobileBrief({ brief }: { brief: Brief }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <Text style={{ color: tokens.foreground }}>
          {brief.groupName ?? t(brief.groupId ? "Group brief" : "Brief")}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.section}>
          <Text selectable style={{ color: tokens.foreground }}>
            {brief.content}
          </Text>
          {brief.rewrittenAt ? (
            <Text style={{ color: tokens.mutedForeground }}>
              {t("Rewritten {time}", { time: new Date(brief.rewrittenAt).toLocaleString() })}
            </Text>
          ) : null}
          {brief.reason ? (
            <Text style={{ color: tokens.mutedForeground }}>
              {t("Left unchanged: {reason}", { reason: t(brief.reason) })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
export function MobileRunContext({
  snapshot,
  routingRule,
}: {
  snapshot?: ContextSnapshot | null;
  routingRule?: string | null;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  if (!snapshot && routingRule !== "default") return null;
  return (
    <Text style={{ color: tokens.mutedForeground }}>
      {routingRule === "default"
        ? t("Routed by default")
        : `${t("Time to first token")}: ${milliseconds(snapshot?.timeToFirstTokenMs)}`}
    </Text>
  );
}
export function ContextSection({
  botId,
  groupId,
  label,
  settings = true,
}: {
  botId: string;
  groupId?: string;
  label?: string;
  settings?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const [value, setValue] = useState<Awaited<ReturnType<typeof loadContext>> | null>(null);
  const [error, setError] = useState(false);
  const [period, setPeriod] = useState<"today" | "sevenDays">("today");
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError(false);
    setValue(null);
    loadContext(botId, groupId)
      .then((value) => {
        if (active) setValue(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [botId, groupId, open, version]);
  const metrics = value?.metrics[period].find((row) => row.groupId === (groupId ?? null));
  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <Text style={{ color: tokens.foreground }}>{label ?? t("Context")}</Text>
      </Pressable>
      {open ? (
        <View style={styles.section}>
          {error ? (
            <Pressable accessibilityRole="button" onPress={() => setVersion((v) => v + 1)}>
              <Text style={{ color: tokens.destructive }}>
                {t("Could not load data")} · {t("Retry")}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => setPeriod(period === "today" ? "sevenDays" : "today")}
          >
            <Text style={{ color: tokens.foreground }}>
              {t(period === "today" ? "Today" : "7 days")}
            </Text>
          </Pressable>
          <Text style={{ color: tokens.foreground }}>
            {t("Time to first token")} (p50 / p95): {milliseconds(metrics?.timeToFirstTokenP50Ms)} /{" "}
            {milliseconds(metrics?.timeToFirstTokenP95Ms)}
          </Text>
          <Text style={{ color: tokens.foreground }}>
            {t("Context")}: {metrics?.averagePromptCharacters ?? "—"}
          </Text>
          <Text style={{ color: tokens.foreground }}>
            {t("Cache hits")}:{" "}
            {metrics?.cacheHitRatio == null ? "—" : `${Math.round(metrics.cacheHitRatio * 100)}%`}
          </Text>
          <Text style={{ color: tokens.foreground }}>
            {t("Queue wait")} (p50 / p95): {milliseconds(metrics?.queueWaitP50Ms)} /{" "}
            {milliseconds(metrics?.queueWaitP95Ms)}
          </Text>
          {settings && value ? (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                presentMessageActionSheet({
                  title: t("Concurrent runs"),
                  cancel: t("Cancel"),
                  more: t("More"),
                  colorScheme,
                  actions: Array.from({ length: 16 }, (_, index) => ({
                    text: String(index + 1),
                    onPress: () => {
                      void rpc("bots/update", { botId, concurrentRuns: index + 1 })
                        .then(() => setVersion((v) => v + 1))
                        .catch(() => setError(true));
                    },
                  })),
                })
              }
            >
              <Text style={{ color: tokens.foreground }}>
                {t("Concurrent runs")}: {value.concurrentRuns}
              </Text>
            </Pressable>
          ) : null}
          {value?.briefs.map((brief) => (
            <MobileBrief key={brief.threadId} brief={brief} />
          ))}
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({ section: { gap: 12, marginVertical: 12 } });
