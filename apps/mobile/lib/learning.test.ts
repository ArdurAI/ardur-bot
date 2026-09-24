// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc: request }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (value: string) => value }) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ border: "gray", destructive: "red" }) }));
vi.mock("./native", () => ({
  native: { page: "white", label: "black", secondaryLabel: "gray" },
  useThemedStyles: (fn: () => unknown) => fn(),
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ botId: "bot" }),
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => createElement("div", {}, children),
}));
vi.mock("react-native", () => {
  const box = ({ children }: { children: ReactNode }) => createElement("div", {}, children);
  return {
    View: box,
    Text: box,
    ScrollView: box,
    ActivityIndicator: () => null,
    StyleSheet: { create: (styles: unknown) => styles },
    Switch: () => null,
    Button: ({
      title,
      onPress,
      disabled,
    }: {
      title: string;
      onPress: () => void;
      disabled?: boolean;
    }) => createElement("button", { type: "button", onClick: onPress, disabled }, title),
  };
});

import Learning from "../app/learning";
import { learningAction, learningBeforeAfter, loadLearning } from "./learning";

const proposal = {
  id: "proposal",
  type: "memory",
  scope: { spaceId: "space", userId: "user", botId: "bot" },
  target: {},
  proposedContent: "Use numbered steps.",
  rationale: "Requested format",
  evidenceIds: ["source"],
  confidence: { label: "model estimate", value: 0.8 },
  diff: "--- current\n+++ proposed\n-Old\n+New",
  expiresAt: "2099-01-01T00:00:00.000Z",
  status: "pending",
};
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it("uses shared contracts for scoped list, approval and before/after text", async () => {
  request
    .mockResolvedValueOnce({
      reviews: [],
      proposals: [proposal],
      pendingCount: 1,
      appliedThisWeek: 0,
    })
    .mockResolvedValueOnce({ proposal: { ...proposal, status: "applied" } });
  expect((await loadLearning("bot")).proposals).toHaveLength(1);
  expect((await learningAction("approve", "proposal")).proposal.status).toBe("applied");
  expect(request.mock.calls).toEqual([
    ["learning/list", { botId: "bot" }],
    ["learning/approve", { proposalId: "proposal" }],
  ]);
  expect(learningBeforeAfter(proposal.diff)).toEqual({ before: "Old", after: "New" });
});
it("renders the native list, approves, shows applied copy and supports Undo without grants", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let current = proposal;
  request.mockImplementation(async (path: string) => {
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    if (path === "learning/approve") {
      current = { ...proposal, status: "applied" };
      return { proposal: current };
    }
    if (path === "learning/revert") {
      current = { ...proposal, status: "reverted" };
      return { proposal: current };
    }
    return {
      reviews: [],
      proposals: [current],
      pendingCount: current.status === "pending" ? 3 : 0,
      appliedThisWeek: current.status === "applied" ? 1 : 0,
    };
  });
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    expect(container.textContent).toContain("3 suggestions to review");
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve",
    );
    expect(approve).toBeDefined();
    await act(async () => approve!.click());
    expect(container.textContent).toContain("Applied");
    expect(container.textContent).toContain("learned 1 things this week");
    const undo = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Undo",
    );
    await act(async () => undo!.click());
    expect(container.textContent).toContain("Undone");
    expect(
      request.mock.calls.some(([path]) => path.includes("Grant") || path.includes("grants")),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

it("preserves content that resembles a diff header", () => {
  expect(learningBeforeAfter("--- current\n+++ proposed\n--- current\n+++ proposed")).toEqual({
    before: "-- current",
    after: "++ proposed",
  });
});
