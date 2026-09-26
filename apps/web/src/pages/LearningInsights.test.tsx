// @vitest-environment jsdom
import type { InsightEvidence, LearningInsight } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { INSIGHT_ACTION_EVENT } from "../lib/insight-actions";

const api = vi.hoisted(() => ({
  insights: vi.fn(),
  dismissInsight: vi.fn(async () => ({ ok: true })),
  actOnInsight: vi.fn(async () => ({ ok: true })),
  allowInsightTool: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../lib/rpc", () => ({ rpc: { learning: api } }));
const interpolate = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((message, part, i) => message + part + (values[i] ?? ""), "");
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray, ...values: unknown[]) => ({
    message: interpolate(parts, ...values),
  }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: interpolate,
    i18n: { locale: "en", _: (descriptor: { message: string }) => descriptor.message },
  }),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
}));

import LearningInsights, { insightSentence } from "./LearningInsights";

const t = { _: (descriptor: { message?: string }) => descriptor.message ?? "" } as never;
const model = (key: string, label: string, local = false) => ({ key, label, local });
const sonnet = model("pi|anthropic|sonnet|medium", "Claude Sonnet");
const gpt = model("pi|openai|gpt-4.1|medium", "GPT-4.1");
const row = (m: typeof sonnet, completed: number, total: number) => ({
  model: m,
  completed,
  total,
  thumbsUp: 1,
  thumbsDown: 0,
  medianMs: 42_000,
  medianTokens: 12_000,
  costUsd: null,
});
const choice: InsightEvidence = {
  kind: "model-choice",
  variant: "completion",
  taskKind: "coding",
  botName: "Coder",
  better: sonnet,
  other: gpt,
  rows: [row(sonnet, 9, 10), row(gpt, 3, 7)],
  runs: 17,
  days: 30,
};
const insight = (
  id: string,
  evidence: InsightEvidence,
  action: LearningInsight["action"],
): LearningInsight => ({
  id,
  botId: "action" in action && "botId" in action ? action.botId : null,
  status: "active",
  evidence,
  action,
  createdAt: "2026-09-26T00:00:00.000Z",
  expiresAt: "2026-09-28T00:00:00.000Z",
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === text)!;

it("says each kind in one plain sentence about the person's own runs", () => {
  expect(insightSentence(choice, t)).toBe(
    "For coding, Claude Sonnet finished 9 of 10 runs in your runs; GPT-4.1 finished 3 of 7.",
  );
  expect(
    insightSentence(
      { ...choice, variant: "local", better: model("pi|ollama|llama3|", "llama3", true) },
      t,
    ),
  ).toBe("For coding, llama3 on this machine did as well as GPT-4.1 in your runs.");
  expect(
    insightSentence(
      {
        kind: "repeated-failure",
        failure: "context",
        botName: "Local",
        model: model("pi|ollama|llama3|", "llama3", true),
        streak: 5,
        suggested: sonnet,
        contextWindow: 8192,
        suggestedContextWindow: 200_000,
        runs: 5,
        days: 30,
      },
      t,
    ),
  ).toBe(
    "Local's last 5 runs on llama3 failed because the conversation was too long for it; Claude Sonnet takes a larger context.",
  );
  expect(insightSentence({ kind: "memory-search", documents: 450, bytes: 90_000 }, t)).toBe(
    "Most of your 450 memories never reach your bots.",
  );
  expect(
    insightSentence(
      { kind: "approval", botName: "Coder", tool: "notion_search_pages", approvals: 12, days: 7 },
      t,
    ),
  ).toBe("You approved notion_search_pages for Coder 12 times this week.");
  expect(
    insightSentence(
      { kind: "connection", problem: "rejected", connection: "OpenAI", runs: 3, days: 14 },
      t,
    ),
  ).toBe("OpenAI rejected its sign-in; 3 runs could not use it.");
});

it("renders nothing without insights", async () => {
  api.insights.mockResolvedValue({ insights: [] });
  await act(async () => root.render(<LearningInsights botId="coder" />));
  expect(api.insights).toHaveBeenCalledWith({ botId: "coder" });
  expect(container.innerHTML).toBe("");
});

it("reveals the numbers in Details, dismisses, and opens the exact place to act", async () => {
  api.insights.mockResolvedValue({
    insights: [insight("choice", choice, { kind: "bot-model", botId: "coder" })],
  });
  await act(async () => root.render(<LearningInsights />));
  expect(container.textContent).toContain("Based on 17 runs in the last 30 days.");
  expect(container.querySelector("table")?.textContent).toContain("9/10");

  const opened = vi.fn();
  window.addEventListener(INSIGHT_ACTION_EVENT, opened);
  await act(async () => button("Change model").click());
  window.removeEventListener(INSIGHT_ACTION_EVENT, opened);
  expect(api.actOnInsight).toHaveBeenCalledWith({ insightId: "choice" });
  expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({
    kind: "bot-model",
    botId: "coder",
  });

  api.insights.mockResolvedValue({ insights: [] });
  await act(async () => button("Dismiss").click());
  expect(api.dismissInsight).toHaveBeenCalledWith({ insightId: "choice" });
  expect(container.innerHTML).toBe("");
});

it("asks the server to allow a read tool only after the person confirms it", async () => {
  api.insights.mockResolvedValue({
    insights: [
      insight(
        "approval",
        { kind: "approval", botName: "Coder", tool: "notion_search_pages", approvals: 6, days: 7 },
        { kind: "approval-rule", botId: "coder", tool: "notion_search_pages" },
      ),
    ],
  });
  await act(async () => root.render(<LearningInsights />));
  await act(async () => button("Always allow").click());
  expect(api.allowInsightTool).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Allow notion_search_pages for Coder without asking?");
  await act(async () => button("Allow").click());
  expect(api.allowInsightTool).toHaveBeenCalledWith({ insightId: "approval" });
  expect(api.actOnInsight).not.toHaveBeenCalled();
});
