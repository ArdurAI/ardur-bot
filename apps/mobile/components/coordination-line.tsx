import type { CoordinationBlock } from "@ardurbot/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import {
  coordinationAccessibilityLabel,
  coordinationFailureFixable,
  coordinationFailureLine,
  coordinationMemberOutcome,
  coordinationSummary,
} from "../lib/coordination";
import { useI18n } from "../lib/i18n";
import { watchMotionAllowed, workRecordShouldPulse } from "../lib/work-record";
import { NativeSymbol } from "./native-symbol";

/**
 * One coordination round, collapsed to a single line in the mobile thread. The
 * request, progress notes and member outcomes appear only when expanded; a
 * member that could not answer for a fixable reason gets one plain line with a
 * fix link to that bot's model settings.
 */
export function CoordinationLine({
  block,
  actionProps,
  onOpenMemberSettings,
}: {
  block: CoordinationBlock;
  actionProps: Record<string, unknown>;
  onOpenMemberSettings?: (botId: string) => void;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const failed = useMemo(
    () => block.members.find((member) => member.outcome === "failed"),
    [block.members],
  );
  const anyPending = block.members.some((member) => member.outcome === "pending");

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const [motionAllowed, setMotionAllowed] = useState(false);
  // Only an open round pulses, and only while Reduce Motion is off.
  useEffect(() => {
    if (!anyPending) return;
    return watchMotionAllowed(setMotionAllowed);
  }, [anyPending]);
  useEffect(() => {
    if (!workRecordShouldPulse(anyPending, motionAllowed)) return;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.5, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => {
      pulse.stop();
      pulseAnim.setValue(1);
    };
  }, [pulseAnim, anyPending, motionAllowed]);

  return (
    <View style={{ width: "100%", paddingVertical: 4 }} accessible>
      <Pressable
        {...actionProps}
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={coordinationAccessibilityLabel(block)}
        accessibilityState={{ expanded }}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }}
      >
        {anyPending ? (
          <Animated.View
            style={{
              height: 2,
              backgroundColor: tokens.foreground,
              opacity: pulseAnim,
              flex: 1,
              maxWidth: 150,
            }}
          />
        ) : (
          <NativeSymbol
            ios="checkmark"
            android="checkmark-outline"
            size={14}
            color={tokens.success}
          />
        )}
        <Text style={{ color: tokens.mutedForeground, fontSize: 13.5, flex: 1 }} numberOfLines={1}>
          {coordinationSummary(block)}
        </Text>
        <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>{expanded ? "▾" : "▸"}</Text>
      </Pressable>
      {!expanded && failed ? (
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          accessibilityLabel={coordinationFailureLine(failed)}
        >
          <Text style={{ color: tokens.mutedForeground, fontSize: 13, flex: 1 }} numberOfLines={2}>
            {coordinationFailureLine(failed)}
          </Text>
          {coordinationFailureFixable(failed) ? (
            <Pressable
              onPress={() => onOpenMemberSettings?.(failed.botId)}
              accessibilityRole="button"
              accessibilityLabel={t("Fix")}
            >
              <Text style={{ color: tokens.foreground, fontSize: 13, fontWeight: "600" }}>
                {t("Fix")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {expanded ? (
        <View
          style={{
            marginTop: 6,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.card,
            paddingHorizontal: 14,
            paddingVertical: 10,
            gap: 8,
          }}
        >
          <Text style={{ color: tokens.mutedForeground, fontSize: 13.5 }}>{block.text}</Text>
          {block.updates.map((update, index) => (
            <Text key={index} style={{ color: tokens.mutedForeground, fontSize: 13, opacity: 0.8 }}>
              {update}
            </Text>
          ))}
          {block.members.map((member) => (
            <View key={member.botId} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text
                style={{ color: tokens.mutedForeground, fontSize: 13, flex: 1 }}
                numberOfLines={1}
              >
                {member.name} · {coordinationMemberOutcome(member)}
              </Text>
              {member.outcome === "failed" && coordinationFailureFixable(member) ? (
                <Pressable
                  onPress={() => onOpenMemberSettings?.(member.botId)}
                  accessibilityRole="button"
                  accessibilityLabel={t("Fix")}
                >
                  <Text style={{ color: tokens.foreground, fontSize: 13, fontWeight: "600" }}>
                    {t("Fix")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
