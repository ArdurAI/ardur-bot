import { ChatMarkdown } from "@ardurbot/chat-ui/native";
import type { MessageBlock } from "@ardurbot/contracts";
import { workRecordEntries } from "@ardurbot/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Pressable, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";
import { NativeCommandBlock } from "./command-block";
import { NativeSymbol } from "./native-symbol";

export function CompactWorkRecord({
  blocks,
  renderBlock,
}: {
  blocks: MessageBlock[];
  renderBlock?: (block: MessageBlock, i: number) => React.ReactNode;
}) {
  const tokens = mobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let isActive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((reduceMotion) => {
      if (!isActive || reduceMotion) return;
      Animated.loop(
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
      ).start();
    });
    return () => {
      isActive = false;
      pulseAnim.stopAnimation();
    };
  }, [pulseAnim]);

  const entries = useMemo(() => workRecordEntries(blocks), [blocks]);

  if (entries.length === 0) return null;

  const active = entries.filter((m) => m.evidence.outcome === "pending");
  const isDone = active.length === 0;
  const currentState = active.length > 0 ? active[active.length - 1] : entries[entries.length - 1];
  // Reasoning summaries render only as full expanded rows; the collapsed
  // status line falls back to the generic label rather than a clipped copy.
  const headerTitle =
    currentState && currentState.evidence.label !== "reasoning"
      ? currentState.evidence.title
      : undefined;

  return (
    <View style={{ marginVertical: 8, width: "100%" }}>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
        accessibilityRole="button"
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
          {isDone && (
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
            }}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {headerTitle ?? (isDone ? t("Done") : t("Working"))}
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
            const customRender = renderBlock?.(m.block, i);
            if (customRender) {
              return <View key={i}>{customRender}</View>;
            }
            if (m.block.kind === "command") {
              return (
                <View key={i} style={{ marginTop: 4 }}>
                  <NativeCommandBlock block={m.block.command} />
                </View>
              );
            }
            if (m.evidence.label === "reasoning" && m.block.kind === "progress") {
              // Reasoning summaries render in full, as Markdown, and update as
              // the text streams. They never appear in the reply bubble.
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
