// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc: request }));
vi.mock("./MemoryControls", () => ({
  MemoryControls: () => null,
  MemoryIntentControls: () => null,
}));
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
    Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) =>
      createElement("button", { type: "button", onClick: onPress }, children),
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
import Memory from "../app/memory";
import {
  learningAction,
  learningBeforeAfter,
  loadLearning,
  loadLearningProposal,
} from "./learning";

const observation = {
  documentId: "doc",
  revisionId: "doc:2",
  exposedRuns: 1,
  correctionsAfter: { feedback: 1, steering: 0 },
  before: {
    runs: 9,
    comparableExposedRuns: 1,
    corrections: { feedback: 3, steering: 0 },
    window: { from: "2026-09-03T00:00:00.000Z", to: "2026-09-10T00:00:00.000Z" },
  },
  denialsAfter: { inappropriate: 0, safety: 0, unknown: 0 },
  failuresAfter: { task: 0, integration: 0, provider: 0, pin: 0, unknown: 0 },
  cancellationsAfter: 0,
  acceptance: { accepted: 0, evaluated: 0, contracts: 0 },
  timeTokensDelta: {
    timeMs: { beforeSamples: 9, afterSamples: 1, beforeMean: 60000, afterMean: 60000, delta: null },
    tokens: { beforeSamples: 9, afterSamples: 1, beforeMean: 100, afterMean: 100, delta: null },
  },
  window: { from: "2026-09-10T00:00:00.000Z", to: "2026-09-17T00:00:00.000Z" },
  missing: [
    "No feedback is not approval.",
    "Task-contract acceptance is unavailable.",
    "Not enough runs to tell",
  ],
};
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
    if (path === "learning/observation") return observation;
    if (path === "learning/journey")
      return [
        {
          id: "audit:a",
          at: "2026-09-10T00:00:00.000Z",
          action: "applied",
          proposalId: "proposal",
          documentId: "doc",
          revisionId: "doc:2",
        },
      ];
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    if (path === "learning/approve") {
      current = {
        ...proposal,
        status: "applied",
        documentId: "doc",
        appliedRevisionId: "doc:2",
      } as typeof proposal;
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
    const details = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Details",
    );
    await act(async () => details!.click());
    expect(container.textContent).toContain("Not enough runs to tell");
    expect(container.textContent).toContain("No feedback is not approval");
    const timeline = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Timeline",
    );
    await act(async () => timeline!.click());
    expect(container.textContent).toContain("doc:2");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Approve")).toBe(
      false,
    );
    await act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Inbox")!.click(),
    );
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
it("loads a timeline proposal directly instead of relying on the current inbox page", async () => {
  request.mockResolvedValue(proposal);
  expect((await loadLearningProposal(proposal.id)).id).toBe(proposal.id);
  expect(request).toHaveBeenCalledWith("learning/proposal", { proposalId: proposal.id });
});
it("opens observations for an owner-authored revision from native document history", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const revision = {
    documentId: "doc",
    revision: 2,
    scopeKey: { kind: "user", spaceId: "space", userId: "user" },
    path: "notes.md",
    content: "Use numbered steps.",
    author: { kind: "user", userId: "user" },
    model: null,
    runId: null,
    threadId: null,
    references: [],
    createdAt: "2026-09-10T00:00:00.000Z",
    deletedAt: null,
  };
  const head = {
    ...revision,
    id: "doc",
    updatedAt: revision.createdAt,
    delivery: { status: "delivered", generation: 0, provider: null },
  };
  request.mockImplementation(async (path: string) => {
    if (path === "memory/list") return { items: [head], nextCursor: null };
    if (path === "memory/history") return { items: [revision], nextCursor: null };
    if (path === "learning/observation") return observation;
    return null;
  });
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Memory)));
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Use numbered steps."))!
        .click(),
    );
    expect(request.mock.calls.some(([path]) => path === "learning/observation")).toBe(false);
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent === "Observations")!
        .click(),
    );
    expect(request).toHaveBeenCalledWith("learning/observation", {
      documentId: "doc",
      revision: 2,
    });
    expect(container.textContent).toContain("Not enough runs to tell");
  } finally {
    await act(async () => root.unmount());
  }
});
