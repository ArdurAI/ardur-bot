import type { Goal, GoalPlanStep } from "@ardurbot/contracts";
import { GOAL_FINAL_REVIEW_DESCRIPTION } from "@ardurbot/contracts";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { MobileGroup } from "../lib/api";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { RpcError } from "../lib/rpc-error";

function supportKindLabel(kind: "artifact" | "tool-result" | "run") {
  if (kind === "artifact") return "Artifact";
  if (kind === "run") return "Run record";
  return "Tool record";
}

// Next step first: in flight, then ready, then blocked, then finished and cancelled.
const PLAN_RANK: Record<string, number> = {
  active: 0,
  pending: 1,
  blocked: 2,
  done: 3,
  cancelled: 4,
};

/** Owner home sessions only; paired-device grants retain their existing restrictions. */
export function GoalBudgetDetails({ groupId }: { groupId: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [goal, setGoal] = useState<Goal | null>(null);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const [settling, setSettling] = useState<string | null>(null);
  const [boardError, setBoardError] = useState(false);
  const [planError, setPlanError] = useState(false);
  useEffect(() => {
    let active = true;
    rpc<MobileGroup[]>("groups/list")
      .then((groups) => {
        if (!active) return;
        const names: Record<string, string> = {};
        for (const group of groups)
          for (const member of group.members ?? []) names[member.botId] = member.name;
        setMemberNames(names);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
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
  const planSteps = goal.plan
    ? [...goal.plan.steps].sort((a, b) => PLAN_RANK[a.status]! - PLAN_RANK[b.status]!)
    : [];
  const planStepById = new Map(goal.plan?.steps.map((step) => [step.id, step]) ?? []);
  const planStatus = (status: string) =>
    status === "active"
      ? t("Active")
      : status === "blocked"
        ? t("Blocked")
        : status === "done"
          ? t("Done")
          : status === "cancelled"
            ? t("Cancelled")
            : t("Pending");
  const planBlockerTitles = (step: GoalPlanStep) =>
    step.prerequisiteIds.flatMap((id) => {
      const pre = planStepById.get(id);
      return pre && pre.status !== "done" ? [pre.title] : [];
    });
  const planChange = async (call: () => Promise<unknown>) => {
    if (settling || !goal) return;
    setSettling("plan");
    setPlanError(false);
    try {
      await call();
      setGoal(await rpc<Goal | null>("goals/get", { groupId }));
    } catch (cause) {
      // A stale revision means the plan moved under this view; a refresh shows
      // the truth. Anything else says so. A failed refresh keeps the card.
      const reason =
        cause instanceof RpcError &&
        cause.data &&
        typeof cause.data === "object" &&
        "reason" in cause.data
          ? (cause.data as { reason?: unknown }).reason
          : undefined;
      const fresh = await rpc<Goal | null>("goals/get", { groupId }).catch(() => undefined);
      if (fresh !== undefined) setGoal(fresh);
      if (reason !== "revision-changed") setPlanError(true);
    } finally {
      setSettling(null);
    }
  };
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
          {goal.plan && goal.plan.steps.length > 0 ? (
            <View style={{ gap: 2 }}>
              <Text style={{ color: tokens.foreground }}>{t("Plan")}</Text>
              {planSteps.map((step) => {
                const blockers =
                  step.status === "pending" || step.status === "blocked"
                    ? planBlockerTitles(step)
                    : [];
                const outstanding =
                  step.status === "pending" ||
                  step.status === "active" ||
                  step.status === "blocked";
                return (
                  <View key={step.id} style={{ gap: 1 }}>
                    <Text style={{ color: tokens.foreground }}>
                      {step.title} ·{" "}
                      {step.ownerIsUser ? t("You") : (memberNames[step.ownerId] ?? step.ownerId)} ·{" "}
                      {planStatus(step.status)}
                    </Text>
                    {blockers.length ? (
                      <Text style={{ color: tokens.mutedForeground }}>
                        {t("Waiting for")} {blockers.join(", ")}
                      </Text>
                    ) : null}
                    {goal.status === "running" ? (
                      <View style={{ flexDirection: "row", gap: 16 }}>
                        {step.ownerIsUser &&
                        (step.status === "pending" || step.status === "blocked") ? (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ busy: settling === "plan" }}
                            disabled={settling !== null}
                            onPress={() =>
                              void planChange(() =>
                                rpc<Goal>("goals/planOutcome", {
                                  goalId: goal.id,
                                  stepId: step.id,
                                  baseRevision: goal.plan?.revision ?? 0,
                                  support: [],
                                }),
                              )
                            }
                          >
                            <Text style={{ color: tokens.foreground }}>{t("Mark done")}</Text>
                          </Pressable>
                        ) : null}
                        {outstanding ? (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ busy: settling === "plan" }}
                            disabled={settling !== null}
                            onPress={() =>
                              void planChange(() =>
                                rpc<Goal>("goals/planStep", {
                                  goalId: goal.id,
                                  stepId: step.id,
                                  baseRevision: goal.plan?.revision ?? 0,
                                  action: "cancel",
                                }),
                              )
                            }
                          >
                            <Text style={{ color: tokens.foreground }}>{t("Cancel")}</Text>
                          </Pressable>
                        ) : (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ busy: settling === "plan" }}
                            disabled={settling !== null}
                            onPress={() =>
                              void planChange(() =>
                                rpc<Goal>("goals/planStep", {
                                  goalId: goal.id,
                                  stepId: step.id,
                                  baseRevision: goal.plan?.revision ?? 0,
                                  action: "reopen",
                                }),
                              )
                            }
                          >
                            <Text style={{ color: tokens.foreground }}>{t("Reopen")}</Text>
                          </Pressable>
                        )}
                      </View>
                    ) : null}
                  </View>
                );
              })}
              {planError ? (
                <Text style={{ color: tokens.mutedForeground }}>
                  {t("Could not update the plan. Try again.")}
                </Text>
              ) : null}
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
