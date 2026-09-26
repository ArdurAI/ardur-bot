import type { InsightEvidence, InsightTaskKind, LearningInsight } from "@ardurbot/contracts";
import { LearningInsightsSchema } from "@ardurbot/contracts";
import { rpc } from "./api";
import { t as translate } from "./i18n";

type T = typeof translate;

export async function loadLearningInsights(botId?: string) {
  return LearningInsightsSchema.parse(await rpc("learning/insights", { botId })).insights;
}
export async function dismissLearningInsight(insightId: string) {
  await rpc("learning/dismissInsight", { insightId });
}
export async function actOnLearningInsight(insightId: string) {
  await rpc("learning/actOnInsight", { insightId });
}

function taskLabel(task: InsightTaskKind, t: T) {
  if (task === "coding") return t("coding");
  if (task === "research") return t("research");
  if (task === "routine") return t("board and routine work");
  return t("conversation");
}

function percentLower(better: number | null | undefined, other: number | null | undefined) {
  return better != null && other ? Math.round((1 - better / other) * 100) : 0;
}

/** The same sentences as web, through the mobile catalog. */
export function insightSentence(evidence: InsightEvidence, t: T = translate): string {
  switch (evidence.kind) {
    case "model-choice": {
      const a = evidence.rows.find((row) => row.model.key === evidence.better.key);
      const b = evidence.rows.find((row) => row.model.key === evidence.other.key);
      const values = {
        task: taskLabel(evidence.taskKind, t),
        better: evidence.better.label,
        other: evidence.other.label,
      };
      if (evidence.variant === "completion")
        return t(
          "For {task}, {better} finished {finished} of {total} runs in your runs; {other} finished {otherFinished} of {otherTotal}.",
          {
            ...values,
            finished: a?.completed ?? 0,
            total: a?.total ?? 0,
            otherFinished: b?.completed ?? 0,
            otherTotal: b?.total ?? 0,
          },
        );
      if (evidence.variant === "local")
        return t(
          "For {task}, {better} on this machine did as well as {other} in your runs.",
          values,
        );
      if (evidence.variant === "tokens")
        return t(
          "For {task}, {better} finished as often as {other} in your runs with {percent}% fewer tokens.",
          { ...values, percent: percentLower(a?.medianTokens, b?.medianTokens) },
        );
      return t(
        "For {task}, {better} finished as often as {other} in your runs in {percent}% less time.",
        { ...values, percent: percentLower(a?.medianMs, b?.medianMs) },
      );
    }
    case "repeated-failure": {
      const values = {
        bot: evidence.botName,
        count: evidence.streak,
        model: evidence.model.label,
        suggested: evidence.suggested?.label ?? "",
      };
      const suggested = !!evidence.suggested;
      if (evidence.failure === "tools")
        return suggested
          ? t(
              "{bot}'s last {count} runs on {model} failed because it cannot use tools; {suggested} used tools in your runs.",
              values,
            )
          : t("{bot}'s last {count} runs on {model} failed because it cannot use tools.", values);
      if (evidence.failure === "context")
        return suggested
          ? t(
              "{bot}'s last {count} runs on {model} failed because the conversation was too long for it; {suggested} takes a larger context.",
              values,
            )
          : t(
              "{bot}'s last {count} runs on {model} failed because the conversation was too long for it.",
              values,
            );
      if (evidence.failure === "rate-limit")
        return suggested
          ? t(
              "{bot}'s last {count} runs on {model} were rate limited; {suggested}, on another provider, is available.",
              values,
            )
          : t("{bot}'s last {count} runs on {model} were rate limited.", values);
      return t(
        "{bot}'s last {count} runs on {model} failed because its sign-in was rejected.",
        values,
      );
    }
    case "connection":
      return evidence.problem === "rejected"
        ? t("{connection} rejected its sign-in; {count} runs could not use it.", {
            connection: evidence.connection,
            count: evidence.runs,
          })
        : t("{count} runs needed {connection}, which is not connected.", {
            connection: evidence.connection,
            count: evidence.runs,
          });
    case "memory-search":
      return t("Most of your {count} memories never reach your bots.", {
        count: evidence.documents,
      });
    case "learning-off":
      return t("You gave {count} thumbs with reasons in {days} days, but Learning is off.", {
        count: evidence.reasons,
        days: evidence.days,
      });
    case "approval":
      return t("You approved {tool} for {bot} {count} times this week.", {
        tool: evidence.tool,
        bot: evidence.botName,
        count: evidence.approvals,
      });
    case "routine":
      return t("You sent {bot} the same request {count} times in {days} days.", {
        bot: evidence.botName,
        count: evidence.count,
        days: evidence.days,
      });
  }
}

/** Numbers behind the sentence, one line each. */
export function insightDetails(evidence: InsightEvidence, t: T = translate): string[] {
  const window = (runs: number, days: number) =>
    t("Based on {runs} runs in the last {days} days.", { runs, days });
  switch (evidence.kind) {
    case "model-choice":
      return [
        window(evidence.runs, evidence.days),
        ...evidence.rows.map((row) =>
          [
            row.model.label,
            `${row.completed}/${row.total}`,
            `+${row.thumbsUp} / −${row.thumbsDown}`,
            row.medianMs === null ? "—" : `${Math.round(row.medianMs / 1000)}s`,
            row.medianTokens === null ? "—" : t("{count} tokens", { count: row.medianTokens }),
            ...(row.costUsd === null ? [] : [`$${row.costUsd.toFixed(2)}`]),
          ].join(" · "),
        ),
      ];
    case "repeated-failure":
      return [
        window(evidence.runs, evidence.days),
        ...(evidence.suggested && evidence.suggestedRuns
          ? [
              t("{suggested} finished {count} of your runs.", {
                suggested: evidence.suggested.label,
                count: evidence.suggestedRuns,
              }),
            ]
          : []),
        ...(evidence.suggested && evidence.contextWindow && evidence.suggestedContextWindow
          ? [
              `${evidence.model.label}: ${evidence.contextWindow} · ${evidence.suggested.label}: ${evidence.suggestedContextWindow} ${t("tokens of context")}`,
            ]
          : []),
      ];
    case "connection":
      return [window(evidence.runs, evidence.days)];
    case "memory-search":
      return [
        t("{documents} personal memories, {kb} KB, and memory search is not set up.", {
          documents: evidence.documents,
          kb: Math.round(evidence.bytes / 1024),
        }),
      ];
    case "learning-off":
      return [
        t("Based on {reasons} thumbs with reasons in the last {days} days.", {
          reasons: evidence.reasons,
          days: evidence.days,
        }),
      ];
    case "approval":
      return [
        t("Based on {approvals} approvals and no denials in the last {days} days.", {
          approvals: evidence.approvals,
          days: evidence.days,
        }),
      ];
    case "routine":
      return [
        `“${evidence.prompt}”`,
        t("Based on {count} requests in the last {days} days.", {
          count: evidence.count,
          days: evidence.days,
        }),
      ];
  }
}

/**
 * The action this screen can offer, or null. Mobile has no routine editor and no memory-search
 * setup, so those insights keep only Dismiss here; web and desktop open them.
 */
export function mobileInsightAction(insight: LearningInsight, t: T = translate) {
  const action = insight.action;
  if (action.kind === "bot-model") return { label: t("Change model"), action };
  if (action.kind === "connection")
    return {
      label:
        insight.evidence.kind === "connection" && insight.evidence.problem === "missing"
          ? t("Connect")
          : t("Reconnect"),
      action,
    };
  if (action.kind === "learning-settings") return { label: t("Enable"), action };
  if (action.kind === "approval-rule") return { label: t("Always allow"), action };
  return null;
}
