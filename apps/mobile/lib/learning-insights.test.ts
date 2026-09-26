import type { InsightEvidence, LearningInsight } from "@ardurbot/contracts";
import { expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc: request }));
vi.mock("./i18n", async () => {
  const { RU_MESSAGES } = await import("./locales/ru");
  return {
    t: (text: string, values?: Record<string, string | number>) =>
      (process.env.INSIGHT_LOCALE === "ru" ? (RU_MESSAGES[text] ?? text) : text).replace(
        /\{([A-Za-z0-9_]+)\}/g,
        (match, key: string) =>
          values && Object.hasOwn(values, key) ? String(values[key]) : match,
      ),
  };
});

import {
  allowLearningInsightTool,
  insightDetails,
  insightSentence,
  loadLearningInsights,
  mobileInsightAction,
} from "./learning-insights";

const sonnet = { key: "pi|anthropic|sonnet|", label: "Claude Sonnet", local: false };
const gpt = { key: "pi|openai|gpt-4.1|", label: "GPT-4.1", local: false };
const choice: InsightEvidence = {
  kind: "model-choice",
  variant: "completion",
  taskKind: "coding",
  botName: "Coder",
  better: sonnet,
  other: gpt,
  rows: [
    {
      model: sonnet,
      completed: 9,
      total: 10,
      thumbsUp: 2,
      thumbsDown: 0,
      medianMs: 42_000,
      medianTokens: 12_000,
      costUsd: 1.5,
    },
    {
      model: gpt,
      completed: 3,
      total: 7,
      thumbsUp: 0,
      thumbsDown: 1,
      medianMs: 60_000,
      medianTokens: 20_000,
      costUsd: null,
    },
  ],
  runs: 17,
  days: 30,
};
const insight = (
  evidence: InsightEvidence,
  action: LearningInsight["action"],
): LearningInsight => ({
  id: "insight",
  botId: null,
  status: "active",
  evidence,
  action,
  createdAt: "2026-09-26T00:00:00.000Z",
  expiresAt: "2026-09-28T00:00:00.000Z",
});

it("loads the person's insights for one bot", async () => {
  request.mockResolvedValueOnce({ insights: [] });
  await expect(loadLearningInsights("coder")).resolves.toEqual([]);
  expect(request).toHaveBeenCalledWith("learning/insights", { botId: "coder" });
});

it("asks the server to save Always allow, which re-checks the tool", async () => {
  request.mockResolvedValueOnce({ ok: true });
  await allowLearningInsightTool("insight");
  expect(request).toHaveBeenCalledWith("learning/allowInsightTool", { insightId: "insight" });
});

it("says the same sentence as web and reveals the numbers in Details", () => {
  expect(insightSentence(choice)).toBe(
    "For coding, Claude Sonnet finished 9 of 10 runs in your runs; GPT-4.1 finished 3 of 7.",
  );
  expect(insightDetails(choice)).toEqual([
    "Based on 17 runs in the last 30 days.",
    "Claude Sonnet · 9/10 · +2 / −0 · 42s · 12000 tokens · $1.50",
    "GPT-4.1 · 3/7 · +0 / −1 · 60s · 20000 tokens",
  ]);
  process.env.INSIGHT_LOCALE = "ru";
  expect(insightSentence({ kind: "memory-search", documents: 450, bytes: 1 })).toBe(
    "Большинство из ваших записей памяти (450) не доходят до ботов.",
  );
  delete process.env.INSIGHT_LOCALE;
});

it("offers only the actions mobile can open, and keeps Dismiss for the rest", () => {
  expect(mobileInsightAction(insight(choice, { kind: "bot-model", botId: "coder" }))?.label).toBe(
    "Change model",
  );
  expect(
    mobileInsightAction(
      insight(
        { kind: "connection", problem: "missing", connection: "Anthropic", runs: 2, days: 14 },
        { kind: "connection", provider: "anthropic" },
      ),
    )?.label,
  ).toBe("Connect");
  expect(
    mobileInsightAction(
      insight(
        { kind: "routine", botName: "Coder", prompt: "Summarize PRs", count: 3, days: 14 },
        { kind: "routine", botId: "coder", prompt: "Summarize PRs" },
      ),
    ),
  ).toBeNull();
  expect(
    mobileInsightAction(
      insight({ kind: "memory-search", documents: 60, bytes: 1 }, { kind: "memory-settings" }),
    ),
  ).toBeNull();
});
