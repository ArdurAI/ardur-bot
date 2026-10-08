import type { Goal } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** Owner home sessions only; paired-device grants retain their existing restrictions. */
export function GoalBudgetDetails({ groupId }: { groupId: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [goal, setGoal] = useState<Goal | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setGoal(null);
    async function refresh() {
      try {
        const next = await rpc<Goal | null>("goals/get", { groupId });
        if (active) setGoal(next);
      } catch {
        if (active) setGoal(null);
      } finally {
        if (active) timer = setTimeout(() => void refresh(), expanded ? 5_000 : 30_000);
      }
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [groupId, expanded]);
  if (!goal || goal.groupId !== groupId) return null;
  const value = (count: number | null) => count?.toLocaleString() ?? t("Unknown");
  return (
    <View style={{ marginTop: 16, gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text style={{ color: tokens.foreground }}>{t("Goal")}</Text>
      </Pressable>
      {expanded ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: tokens.foreground }}>
            {t("Used")}: {value(goal.usedTokens)}
          </Text>
          <Text style={{ color: tokens.foreground }}>
            {t("Reserved")}: {value(goal.reservedTokens)}
          </Text>
          <Text style={{ color: tokens.foreground }}>
            {t("Available")}: {value(goal.availableTokens)}
          </Text>
          {!goal.usageComplete ? (
            <Text style={{ color: tokens.mutedForeground }}>{t("Usage incomplete")}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
