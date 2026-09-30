import type { ChiefDispatch, MessageBlock } from "@ardurbot/contracts";
import type { CoordinationBlock } from "@ardurbot/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, Linking, Pressable, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { openMobileArtifact } from "../lib/artifact-open";
import {
  chiefActivityText,
  chiefDispatchSummary,
  chiefResultText,
  coordinationAccessibilityLabel,
  coordinationFailureFixable,
  coordinationFailureLine,
  coordinationMemberOutcome,
  coordinationSummary,
} from "../lib/coordination";
import { useI18n } from "../lib/i18n";
import { watchMotionAllowed, workRecordShouldPulse } from "../lib/work-record";
import { NativeSymbol } from "./native-symbol";

export function ChiefResultBubble({
  block,
  actionProps,
}: {
  block: Extract<MessageBlock, { kind: "chief_result" }>;
  actionProps: Record<string, unknown>;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const text = chiefResultText(block.result);
  if (!text) return null;
  return (
    <View
      style={{
        backgroundColor: tokens.muted,
        borderRadius: 20,
        paddingHorizontal: 18,
        paddingVertical: 12,
      }}
    >
      <Text style={{ color: tokens.foreground, fontSize: 15.5 }}>{text}</Text>
      <Pressable
        {...actionProps}
        accessibilityRole="link"
        accessibilityLabel={block.name}
        style={{ minHeight: 44, justifyContent: "center" }}
        onPress={() => {
          const opening =
            block.result.state === "draft"
              ? openMobileArtifact(
                  block.groupId ? { groupId: block.groupId } : { botId: block.botId },
                  block.result.artifactId,
                  block.name,
                  block.mimeType,
                )
              : Linking.openURL(block.result.href);
          void opening.catch(() => Alert.alert(t("Could not open file"), t("Try again.")));
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 15.5, textDecorationLine: "underline" }}>
          {block.name}
        </Text>
      </Pressable>
    </View>
  );
}

export function ChiefDispatchLine({
  dispatch,
  detail,
  actionProps,
}: {
  dispatch: ChiefDispatch;
  detail: string;
  actionProps: Record<string, unknown>;
}) {
  const tokens = mobileTokens();
  const [expanded, setExpanded] = useState(false);
  const label = chiefDispatchSummary(dispatch);
  const activity = chiefActivityText(dispatch);
  return (
    <View style={{ width: "100%", paddingVertical: 4 }}>
      <Pressable
        {...actionProps}
        onPress={() => setExpanded(!expanded)}
        accessibilityRole="button"
        accessibilityLabel={[label, activity].filter(Boolean).join(" · ")}
        accessibilityState={{ expanded }}
        style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <Text
          style={{ color: tokens.mutedForeground, fontSize: 13.5, flex: 1 }}
          numberOfLines={1}
          accessibilityLiveRegion="polite"
        >
          {label}
        </Text>
        <Text style={{ color: tokens.mutedForeground }}>{expanded ? "▾" : "▸"}</Text>
      </Pressable>
      {activity ? (
        <Text
          style={{ color: tokens.mutedForeground, fontSize: 13.5 }}
          numberOfLines={1}
          accessibilityLiveRegion="polite"
        >
          {activity}
        </Text>
      ) : null}
      {expanded ? (
        <Text style={{ color: tokens.mutedForeground, fontSize: 13.5 }}>{detail}</Text>
      ) : null}
    </View>
  );
}

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
