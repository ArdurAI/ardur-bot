import type { Goal } from "@ardurbot/contracts";
import { GOAL_FINAL_REVIEW_DESCRIPTION } from "@ardurbot/contracts";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { RpcError } from "../lib/rpc-error";

function supportKindLabel(kind: "artifact" | "tool-result" | "run") {
  if (kind === "artifact") return "Artifact";
  if (kind === "run") return "Run record";
  return "Tool record";
}

/** Owner home sessions only; paired-device grants retain their existing restrictions. */
export function GoalBudgetDetails({ groupId }: { groupId: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [goal, setGoal] = useState<Goal | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [settling, setSettling] = useState<string | null>(null);
  const [boardError, setBoardError] = useState(false);
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
  const settle = async (deliveryId: string, action: "retry" | "handle", attempt: number) => {
    if (settling) return;
    setSettling(deliveryId);
    setBoardError(false);
    try {
      await rpc<Goal>("goals/boardDelivery", { goalId: goal.id, deliveryId, action, attempt });
      setGoal(await rpc<Goal | null>("goals/get", { groupId }));
    } catch (cause) {
      // Expected conflicts mean the delivery moved under this view; a refresh
      // shows the truth. Anything else says so. A failed refresh keeps the card.
      const reason =
        cause instanceof RpcError &&
        cause.data &&
        typeof cause.data === "object" &&
        "reason" in cause.data
          ? (cause.data as { reason?: unknown }).reason
          : undefined;
      const fresh = await rpc<Goal | null>("goals/get", { groupId }).catch(() => undefined);
      if (fresh !== undefined) setGoal(fresh);
      if (reason !== "revision-changed" && reason !== "not-awaiting") setBoardError(true);
    } finally {
      setSettling(null);
    }
  };
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
          {goal.currentRevision && goal.currentRevision.conditions.length > 0 ? (
            <View style={{ gap: 2 }}>
              {goal.currentRevision.conditions.map((cond) => (
                <View key={cond.id} style={{ gap: 1 }}>
                  <Text style={{ color: tokens.foreground }}>
                    {cond.description === GOAL_FINAL_REVIEW_DESCRIPTION || cond.id === "cond-final"
                      ? t("Final owner review")
                      : cond.description}
                    :{" "}
                    {cond.status === "pass"
                      ? t("Pass")
                      : cond.status === "fail"
                        ? t("Fail")
                        : t("Unknown")}
                  </Text>
                  {[
                    ...(cond.support ?? []).map((link) => ({ link, proposed: false })),
                    ...(cond.proposedSupport ?? []).map((link) => ({ link, proposed: true })),
                  ].map(({ link, proposed }) => (
                    <Text
                      key={`${proposed ? "proposed" : "attested"}:${link.kind}:${link.recordId}`}
                      style={{ color: tokens.mutedForeground }}
                    >
                      {proposed ? `${t("Proposed")} ` : ""}
                      {t(supportKindLabel(link.kind))} {link.recordId}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          ) : null}
          {goal.boardWorkspaceId && goal.boardItemId ? (
            <Text style={{ color: tokens.foreground }}>
              {t("Board item")}: {goal.boardItemId}
            </Text>
          ) : null}
          {goal.boardWorkspaceId && goal.boardItemId ? (
            <Pressable
              accessibilityRole="link"
              onPress={() =>
                router.push({
                  pathname: "/overview",
                  params: {
                    view: "board",
                    workspace: goal.boardWorkspaceId ?? "",
                    item: goal.boardItemId ?? "",
                  },
                })
              }
            >
              <Text style={{ color: tokens.foreground }}>{t("Open board item")}</Text>
            </Pressable>
          ) : null}
          {goal.boardDelivery && goal.boardDelivery !== "delivered" ? (
            <Text style={{ color: tokens.mutedForeground }}>{t("Board update pending")}</Text>
          ) : null}
          {boardError ? (
            <Text style={{ color: tokens.mutedForeground }}>
              {t("Could not update the board. Try again.")}
            </Text>
          ) : null}
          {goal.boardDeliveryActions?.map((delivery) => (
            <View key={delivery.id} style={{ flexDirection: "row", gap: 16 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: settling === delivery.id }}
                disabled={settling !== null}
                onPress={() => void settle(delivery.id, "retry", delivery.attempt)}
              >
                <Text style={{ color: tokens.foreground }}>{t("Retry board update")}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: settling === delivery.id }}
                disabled={settling !== null}
                onPress={() => void settle(delivery.id, "handle", delivery.attempt)}
              >
                <Text style={{ color: tokens.foreground }}>{t("Mark board update handled")}</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
