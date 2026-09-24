// @vitest-environment jsdom
import type { Comparison, ComparisonParticipant, ComparisonResult } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import ComparisonsScreen, { MobileComparisonOutput } from "../app/comparisons";
import { loadComparisons } from "./comparisons";

vi.mock("./comparisons", () => ({ loadComparisons: vi.fn() }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  ActivityIndicator: () => null,
  useWindowDimensions: () => ({ width: 400 }),
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, title),
  ScrollView: ({
    children,
    horizontal,
    pagingEnabled,
  }: {
    children: ReactNode;
    horizontal?: boolean;
    pagingEnabled?: boolean;
  }) =>
    createElement("div", { "data-horizontal": horizontal, "data-paging": pagingEnabled }, children),
}));
it("opens the read-only list into fixed participant pages with failures and provenance", async () => {
  const participants = ["a", "b"].map(
    (botId): ComparisonParticipant => ({
      botId,
      name: botId,
      executing: {
        pin: {
          runtimeKind: "pi",
          provider: "fixture",
          modelId: `model-${botId}`,
          effort: "high",
          credentialId: "connection",
          revision: 1,
        },
        computer: { id: "computer", kind: "test", mode: "team" },
        destination: { local: true, host: "localhost" },
      },
    }),
  );
  const results = ["b", "a"].map(
    (botId): ComparisonResult => ({
      botId,
      runId: botId,
      delegationId: botId,
      status: botId === "a" ? "waiting-approval" : "failed",
      output: `Output ${botId}`,
      failure: botId === "b" ? "Connection unavailable" : null,
      citations: ["https://example.test/source"],
      outputMessageIds: [],
      outputArtifactIds: [],
      approvals: [],
      durationMs: null,
      startedAt: null,
      completedAt: null,
      usage: { inputTokens: 0, outputTokens: 0, reported: false, costs: [] },
      provenance: {
        reportedModel: null,
        reportedModelVersion: null,
        memoryRead: false,
        memoryDiffered: false,
        ambientHistory: false,
        toolsRestricted: true,
      },
    }),
  );
  vi.mocked(loadComparisons).mockResolvedValue([
    { id: "comparison", participants, results, snapshot: { text: "Frozen task" }, merge: null },
  ] as Comparison[]);
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(createElement(ComparisonsScreen)));
  expect(node.textContent).toContain("Frozen task");
  await act(async () => node.querySelector("button")!.click());
  expect(node.querySelector('[data-horizontal="true"][data-paging="true"]')).not.toBeNull();
  expect(node.textContent!.indexOf("Output a")).toBeLessThan(node.textContent!.indexOf("Output b"));
  expect(node.textContent).toContain("Waiting for approval");
  expect(node.textContent).toContain("Failed — Connection unavailable");
  expect(node.textContent).toContain("Not reported");
  expect(node.textContent).not.toContain("Merge selected");
  expect([...node.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Back",
  ]);
  await act(async () => root.unmount());
});

it.each([false, true, undefined])(
  "matches the web comparison effort suffix for evidence %s",
  async (effortAttested) => {
    const participant = {
      botId: "a",
      name: "Reviewer",
      executing: {
        pin: {
          runtimeKind: "claude-code",
          modelId: "claude-opus-5",
          provider: "anthropic",
          effort: "high",
        },
        computer: { kind: "desktop" },
      },
    } as ComparisonParticipant;
    const result = {
      status: "completed",
      output: "Output",
      citations: [],
      approvals: [],
      durationMs: null,
      usage: { reported: false, costs: [] },
      provenance: { effortAttested },
    } as unknown as ComparisonResult;
    const node = document.createElement("div");
    const root = createRoot(node);
    await act(async () =>
      root.render(createElement(MobileComparisonOutput, { participant, result })),
    );
    expect(node.textContent).toContain(
      `anthropic · claude-opus-5 · high${effortAttested ? "" : " · requested"}`,
    );
    expect(node.textContent?.includes("requested")).toBe(effortAttested !== true);
    await act(async () => root.unmount());
  },
);
