import { ChatMarkdown } from "@ardurbot/chat-ui/native";
import type { MessageBlock } from "@ardurbot/contracts";
import { workRecordEntries, workRecordStatus } from "@ardurbot/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";
import { watchMotionAllowed, workRecordLabel, workRecordShouldPulse } from "../lib/work-record";
import { NativeCommandBlock } from "./command-block";
import { NativeSymbol } from "./native-symbol";

export function CompactWorkRecord({
  blocks,
  live = false,
}: {
  blocks: MessageBlock[];
  /** True for the in-flight turn's streaming message. */
  live?: boolean;
}) {
  const tokens = mobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const entries = useMemo(() => workRecordEntries(blocks, live), [blocks, live]);
  const status = workRecordStatus(entries);
  const active = entries.filter((m) => m.evidence.outcome === "pending");
  const isDone = status !== "working";

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const [motionAllowed, setMotionAllowed] = useState(false);
  // Only an active record pulses, and only while Reduce Motion is off; idle
  // and completed records stay still.
  useEffect(() => {
    if (isDone) return;
    return watchMotionAllowed(setMotionAllowed);
  }, [isDone]);
  useEffect(() => {
    if (!workRecordShouldPulse(!isDone, motionAllowed)) return;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.5,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => {
      pulse.stop();
      pulseAnim.setValue(1);
    };
  }, [pulseAnim, isDone, motionAllowed]);

  if (entries.length === 0) return null;

  const currentState = active.length > 0 ? active[active.length - 1] : entries[entries.length - 1];
  // Collapsed, the status line previews the current activity (a streaming
  // reasoning summary included). Expanded, it steps back to the generic label
  // so the full row below is the single copy of that text.
  const headerTitle = expanded ? undefined : currentState?.evidence.title;

  return (
    <View style={{ marginVertical: 8, width: "100%" }}>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          minHeight: 44,
        }}
        accessibilityRole="button"
        accessibilityLabel={workRecordLabel(status, currentState?.evidence.title ?? "")}
        accessibilityState={{ expanded }}
      >
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }}>
          {!isDone && (
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, maxWidth: 150 }}
            >
              <Animated.View
                style={{
                  height: 2,
                  backgroundColor: tokens.foreground,
                  flex: 1,
                  opacity: pulseAnim,
                }}
              />
              <View
                style={{
                  height: 2,
                  borderTopWidth: 2,
                  borderStyle: "dotted",
                  borderColor: tokens.border,
                  width: 50,
                }}
              />
            </View>
          )}
          {(status === "failed" || status === "interrupted") && (
            <NativeSymbol
              ios="xmark"
              android="close-outline"
              size={14}
              color={tokens.destructive}
            />
          )}
          {status === "unknown" && (
            <NativeSymbol
              ios="checkmark"
              android="checkmark-outline"
              size={14}
              color={tokens.mutedForeground}
            />
          )}
          {status === "done" && (
            <NativeSymbol
              ios="checkmark"
              android="checkmark-outline"
              size={14}
              color={tokens.success}
            />
          )}
          <Text
            style={{
              fontFamily: "Menlo",
              fontSize: 12,
              color: tokens.mutedForeground,
              flexShrink: 1,
              minWidth: 0,
            }}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {headerTitle ??
              (status === "working"
                ? t("Working")
                : status === "failed"
                  ? t("Failed")
                  : status === "interrupted"
                    ? t("Interrupted")
                    : status === "unknown"
                      ? t("Unknown")
                      : t("Done"))}
            {currentState?.evidence.outcome === "pending" && " ..."}
          </Text>
        </View>
        {expanded ? (
          <NativeSymbol
            ios="chevron.down"
            android="chevron-down-outline"
            size={14}
            color={tokens.mutedForeground}
          />
        ) : (
          <NativeSymbol
            ios="chevron.right"
            android="chevron-forward-outline"
            size={14}
            color={tokens.mutedForeground}
          />
        )}
      </Pressable>

      {expanded && (
        <View
          style={{
            flexDirection: "column",
            gap: 12,
            paddingLeft: 16,
            borderLeftWidth: 2,
            borderColor: tokens.border,
            marginTop: 8,
          }}
        >
          {entries.map((m, i) => {
            if (m.block.kind === "command") {
              return (
                <View key={i} style={{ marginTop: 4 }}>
                  <NativeCommandBlock block={m.block.command} />
                </View>
              );
            }
            if (
              m.block.kind === "text" ||
              (m.block.kind === "progress" && m.block.activity !== true)
            ) {
              // Reasoning summaries and interim notes render in full, as
              // Markdown, and update as the text streams. They never appear
              // in the reply bubble.
              return (
                <View key={i} testID="work-record-reasoning">
                  <ChatMarkdown
                    palette={tokens}
                    colorScheme={colorScheme}
                    streaming={m.evidence.outcome === "pending"}
                  >
                    {m.block.text}
                  </ChatMarkdown>
                </View>
              );
            }
            return (
              <View
                key={i}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                }}
              >
                <Text
                  style={{
                    fontFamily: "Menlo",
                    fontSize: 12,
                    color: tokens.mutedForeground,
                    flex: 1,
                  }}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {m.evidence.title}
                </Text>
                <Text
                  style={{
                    fontFamily: "Menlo",
                    fontSize: 12,
                    color: tokens.mutedForeground,
                    opacity: 0.7,
                  }}
                >
                  {m.evidence.outcome === "pending"
                    ? t("running")
                    : m.evidence.durationMs
                      ? `${(m.evidence.durationMs / 1000).toFixed(1)}s`
                      : ""}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}
