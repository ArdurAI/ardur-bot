// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
const i18n = vi.hoisted(() => ({
  locale: "en",
  messages: {} as Record<string, string>,
  t(text: string, values?: Record<string, string | number>) {
    const template = this.messages[text] ?? text;
    if (!values) return template;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
      Object.hasOwn(values, key) ? String(values[key]) : match,
    );
  },
}));
const RpcServerError = vi.hoisted(
  () =>
    class RpcServerError extends Error {
      constructor(
        message: string,
        readonly code?: string,
      ) {
        super(message);
      }
    },
);
vi.mock("./api", () => ({ rpc: request, RpcServerError }));
vi.mock("./MemoryControls", () => ({
  MemoryControls: () => null,
  MemoryIntentControls: () => null,
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({ t: i18n.t.bind(i18n) }),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ border: "gray", destructive: "red" }) }));
vi.mock("./native", () => ({
  native: { page: "white", label: "black", secondaryLabel: "gray" },
  useThemedStyles: (fn: () => unknown) => fn(),
}));
const push = vi.hoisted(() => vi.fn());
vi.mock("expo-router", () => ({
  useRouter: () => ({ push }),
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
  actionMessage,
  learningAction,
  learningBeforeAfter,
  loadLearning,
  loadLearningProposal,
} from "./learning";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";

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
  i18n.locale = "en";
  i18n.messages = {};
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("shows the bot's insights on the Learning screen, dismisses one and opens its model setting", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const sonnet = { key: "pi|anthropic|sonnet|", label: "Claude Sonnet", local: false };
  const gpt = { key: "pi|openai|gpt|", label: "GPT-4.1", local: false };
  const insight = {
    id: "insight",
    botId: "bot",
    status: "active",
    evidence: {
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
          thumbsUp: 0,
          thumbsDown: 0,
          medianMs: 1,
          medianTokens: 1,
          costUsd: null,
        },
        {
          model: gpt,
          completed: 3,
          total: 7,
          thumbsUp: 0,
          thumbsDown: 0,
          medianMs: 1,
          medianTokens: 1,
          costUsd: null,
        },
      ],
      runs: 17,
      days: 30,
    },
    action: { kind: "bot-model", botId: "bot" },
    createdAt: "2026-09-26T00:00:00.000Z",
    expiresAt: "2026-09-28T00:00:00.000Z",
  };
  let insights = [insight];
  request.mockImplementation(async (path: string) => {
    if (path === "learning/insights") return { insights };
    if (path === "learning/dismissInsight") {
      insights = [];
      return { ok: true };
    }
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    if (path === "learning/actOnInsight") return { ok: true };
    return { reviews: [], proposals: [], pendingCount: 0, appliedThisWeek: 0 };
  });
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    expect(request).toHaveBeenCalledWith("learning/insights", { botId: "bot" });
    expect(container.textContent).toContain(
      "For coding, Claude Sonnet finished 9 of 10 runs in your runs; GPT-4.1 finished 3 of 7.",
    );
    const button = (title: string) =>
      [...container.querySelectorAll("button")].find((node) => node.textContent === title)!;
    await act(async () => button("Change model").click());
    expect(request).toHaveBeenCalledWith("learning/actOnInsight", { insightId: "insight" });
    expect(push).toHaveBeenCalledWith({
      pathname: "/bot-settings",
      params: { botId: "bot", focus: "model" },
    });
    await act(async () => button("Dismiss").click());
    expect(request).toHaveBeenCalledWith("learning/dismissInsight", { insightId: "insight" });
    expect(container.textContent).not.toContain("Claude Sonnet");
  } finally {
    act(() => root.unmount());
  }
});

const LEFT_OPEN =
  "This board item changed after it was filed, so it was left open for review on the Board.";
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

it("shows every field Approve will file for a board item, including labels", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
      labels: ["bug", "import"],
    },
  };
  request.mockImplementation(async (path: string) => {
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    return { reviews: [], proposals: [board], pendingCount: 1, appliedThisWeek: 0 };
  });
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    const details = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Details",
    );
    await act(async () => details!.click());
    expect(container.textContent).toContain("bug, import");
  } finally {
    await act(async () => root.unmount());
  }
});
it("shows the board service's own sentence when Approve cannot file the item, not the generic retry text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
  };
  request.mockImplementation(async (path: string) => {
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    if (path === "learning/approve")
      throw new RpcServerError("This bot cannot reach this board's computer.", "FORBIDDEN");
    return { reviews: [], proposals: [board], pendingCount: 1, appliedThisWeek: 0 };
  });
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve",
    );
    await act(async () => approve!.click());
    expect(container.textContent).toContain("This bot cannot reach this board's computer.");
    expect(container.textContent).not.toContain("Could not update learning. Try again.");
  } finally {
    await act(async () => root.unmount());
  }
});
it("shows the translated retry sentence, never the server's own text, for an error it did not map", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockImplementation(async (path: string) => {
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    if (path === "learning/approve")
      throw new RpcServerError("Internal server error", "INTERNAL_SERVER_ERROR");
    return { reviews: [], proposals: [proposal], pendingCount: 1, appliedThisWeek: 0 };
  });
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve",
    );
    await act(async () => approve!.click());
    expect(container.textContent).toContain("Could not update learning. Try again.");
    expect(container.textContent).not.toContain("Internal server error");
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows Closing on the Board until the pending close clears", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    diff: "+Finish the import follow-up",
    status: "rejected",
    boardClosing: true,
  };
  request.mockImplementation(async (path: string) => {
    if (path === "learning/journey") return [];
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    return { reviews: [], proposals: [board], pendingCount: 0, appliedThisWeek: 0 };
  });
  const container = document.createElement("div");
  let root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    expect(container.textContent).toContain("Closing on the Board.");
    i18n.locale = "ru";
    i18n.messages = RU_MESSAGES;
    await act(async () => root.render(createElement(Learning)));
    expect(container.textContent).toContain(RU_MESSAGES["Closing on the Board."]);
    i18n.locale = "zh-CN";
    i18n.messages = ZH_MESSAGES;
    await act(async () => root.render(createElement(Learning)));
    expect(container.textContent).toContain(ZH_MESSAGES["Closing on the Board."]);
    request.mockImplementation(async (path: string) => {
      if (path === "learning/journey") return [];
      if (path === "learning/settings")
        return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
      return {
        reviews: [],
        proposals: [{ ...board, boardClosing: false }],
        pendingCount: 0,
        appliedThisWeek: 0,
      };
    });
    i18n.locale = "en";
    i18n.messages = {};
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(createElement(Learning)));
    expect(container.textContent).toContain("rejected");
    expect(container.textContent).not.toContain("Closing on the Board.");
  } finally {
    await act(async () => root.unmount());
  }
});
const pendingBoard = {
  ...proposal,
  type: "board-item",
  proposedContent: undefined,
  boardItem: {
    title: "Finish the import follow-up",
    description: "The run stopped before the import finished.",
    acceptanceCriteria: "The import completes.",
  },
  diff: "+Finish the import follow-up",
};
it("shows Closing on the Board as soon as Reject answers with the closing code", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let reloads = 0;
  request.mockImplementation(async (path: string) => {
    if (path === "learning/journey") return [];
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    if (path === "learning/reject")
      return { proposal: { ...pendingBoard, status: "rejected" }, code: "board-closing" };
    if (path === "learning/insights") return { insights: [] };
    // The reload after Reject has not answered yet.
    if (reloads++ > 0) return new Promise(() => undefined);
    return { reviews: [], proposals: [pendingBoard], pendingCount: 1, appliedThisWeek: 0 };
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    const reject = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Reject",
    );
    await act(async () => reject?.click());
    expect(container.textContent).toContain("Closing on the Board.");
  } finally {
    await act(async () => root.unmount());
  }
});
it("says a board close that keeps failing could not be closed, and what to do", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const failed = {
    ...pendingBoard,
    status: "rejected",
    boardClosing: true,
    boardCloseFailed: true,
  };
  request.mockImplementation(async (path: string) => {
    if (path === "learning/journey") return [];
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    return { reviews: [], proposals: [failed], pendingCount: 0, appliedThisWeek: 0 };
  });
  const title = "A board item filed by a bot could not be closed.";
  const body =
    "Ardur Bot tried five times. Close it on the Board, or check that this computer is connected.";
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    expect(container.textContent).toContain(title);
    expect(container.textContent).toContain(body);
    expect(container.textContent).not.toContain("Closing on the Board.");
    for (const messages of [RU_MESSAGES, ZH_MESSAGES]) {
      expect(messages[title]).toBeTruthy();
      expect(messages[body]).toBeTruthy();
      i18n.locale = "translated";
      i18n.messages = messages;
      await act(async () => root.render(createElement(Learning)));
      expect(container.textContent).toContain(messages[title]);
      expect(container.textContent).toContain(messages[body]);
    }
  } finally {
    await act(async () => root.unmount());
  }
});
it("shows the changed sentence after a pending close was left with the person", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    diff: "+Finish the import follow-up",
    status: "rejected",
    boardChanged: true,
  };
  request.mockImplementation(async (path: string) => {
    if (path === "learning/journey") return [];
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    return { reviews: [], proposals: [board], pendingCount: 0, appliedThisWeek: 0 };
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    expect(container.textContent).toContain(
      "This board item changed after it was filed. Review it on the Board.",
    );
    expect(container.textContent).not.toContain("Closing on the Board.");
    i18n.locale = "ru";
    i18n.messages = RU_MESSAGES;
    await act(async () => root.render(createElement(Learning)));
    expect(container.textContent).toContain(
      RU_MESSAGES["This board item changed after it was filed. Review it on the Board."],
    );
  } finally {
    i18n.locale = "en";
    i18n.messages = {};
    await act(async () => root.unmount());
  }
});
it("says a board item was closed without being completed and what to do", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    diff: "+Finish the import follow-up",
    status: "applied",
    appliedBoardItem: {
      workspaceId: "workspace",
      itemId: "board-a",
      updatedAt: "2026-09-25T12:00:00.000Z",
      duplicate: false,
    },
    boardOutcome: {
      closedAt: "2026-09-25T13:00:00.000Z",
      outcome: "closed-other",
      closeReason: "No longer needed",
    },
  };
  const quiet = {
    ...board,
    id: "quiet",
    boardOutcome: {
      closedAt: "2026-09-25T13:00:00.000Z",
      outcome: "closed-other",
      closeReason: null,
    },
  };
  request.mockImplementation(async (path: string) => {
    if (path === "learning/journey") return [];
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    return { reviews: [], proposals: [board, quiet], pendingCount: 0, appliedThisWeek: 1 };
  });
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    const details = [...container.querySelectorAll("button")].filter(
      (button) => button.textContent === "Details",
    );
    await act(async () => details[0]!.click());
    expect(container.textContent).toContain(
      "This board item was closed without being completed: No longer needed. Review it on the Board.",
    );
    await act(async () => details[1]!.click());
    expect(container.textContent).toContain(
      "This board item was closed without being completed. Review it on the Board.",
    );
    expect(container.textContent).not.toContain("closed otherwise");
  } finally {
    await act(async () => root.unmount());
  }
});

it("says a board item was closed, without calling it done or not done, for an unrecognized close reason", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    diff: "+Finish the import follow-up",
    status: "applied",
    appliedBoardItem: {
      workspaceId: "workspace",
      itemId: "board-a",
      updatedAt: "2026-09-25T12:00:00.000Z",
      duplicate: false,
    },
    boardOutcome: {
      closedAt: "2026-09-25T13:00:00.000Z",
      outcome: "closed",
      closeReason: null,
    },
  };
  request.mockImplementation(async (path: string) => {
    if (path === "learning/journey") return [];
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    return { reviews: [], proposals: [board], pendingCount: 0, appliedThisWeek: 1 };
  });
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    const details = [...container.querySelectorAll("button")].filter(
      (button) => button.textContent === "Details",
    );
    await act(async () => details[0]!.click());
    expect(container.textContent).toContain("This board item was closed.");
    expect(container.textContent).not.toContain("closed without being completed");
    expect(container.textContent).not.toContain("was completed");
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows the reason for an unclassified close, without judging it done or not done", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    diff: "+Finish the import follow-up",
    status: "applied",
    appliedBoardItem: {
      workspaceId: "workspace",
      itemId: "board-a",
      updatedAt: "2026-09-25T12:00:00.000Z",
      duplicate: false,
    },
    boardOutcome: {
      closedAt: "2026-09-25T13:00:00.000Z",
      outcome: "closed",
      closeReason: "Готово",
    },
  };
  request.mockImplementation(async (path: string) => {
    if (path === "learning/journey") return [];
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    return { reviews: [], proposals: [board], pendingCount: 0, appliedThisWeek: 1 };
  });
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    const details = [...container.querySelectorAll("button")].filter(
      (button) => button.textContent === "Details",
    );
    await act(async () => details[0]!.click());
    expect(container.textContent).toContain("This board item was closed: Готово.");
    expect(container.textContent).not.toContain("Review it on the Board");
    expect(container.textContent).not.toContain("closed without being completed");
    expect(container.textContent).not.toContain("was completed");
  } finally {
    await act(async () => root.unmount());
  }
});

it("says what happened when a filed board item changed before Undo", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    diff: "+Finish the import follow-up",
    status: "applied",
    appliedBoardItem: {
      workspaceId: "workspace",
      itemId: "board-a",
      updatedAt: "2026-09-25T12:00:00.000Z",
      duplicate: false,
    },
  };
  request.mockImplementation(async (path: string) => {
    if (path === "learning/journey") return [];
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    if (path === "learning/revert")
      return {
        proposal: board,
        conflict: { before: "", applied: "board-a", current: "", expectedRevision: 0 },
      };
    return { reviews: [], proposals: [board], pendingCount: 0, appliedThisWeek: 1 };
  });
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    await act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Undo")!.click(),
    );
    expect(container.textContent).toContain(
      "This board item changed after it was filed. Review it on the Board.",
    );
    expect(container.textContent).not.toContain("moved on");
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows the server sentence when Reject leaves a changed board item open", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    diff: "+Finish the import follow-up",
    status: "pending",
  };
  const sentence =
    "This board item changed after it was filed, so it was left open for review on the Board.";
  request.mockImplementation(async (path: string) => {
    if (path === "learning/journey") return [];
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    if (path === "learning/reject")
      return {
        proposal: { ...board, status: "rejected" },
        conflict: { before: "", applied: "board-a", current: sentence, expectedRevision: 0 },
      };
    return { reviews: [], proposals: [board], pendingCount: 1, appliedThisWeek: 0, botNames: {} };
  });
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    await act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Reject")!.click(),
    );
    expect(container.textContent).toContain(sentence);
    expect(container.textContent).not.toContain(
      "This board item changed after it was filed. Review it on the Board.",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  [
    "ru",
    RU_MESSAGES,
    "Эта задача на доске изменилась после создания, поэтому она оставлена открытой для проверки на доске.",
  ],
  ["zh-CN", ZH_MESSAGES, "此看板事项在创建后已有变更，因此仍保持开放，供在看板上复查。"],
] as const)(
  "renders the left-open Reject sentence from the %s catalog",
  async (locale, messages, translated) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const board = {
      ...proposal,
      type: "board-item",
      proposedContent: undefined,
      boardItem: {
        title: "Finish the import follow-up",
        description: "The run stopped before the import finished.",
        acceptanceCriteria: "The import completes.",
      },
      diff: "+Finish the import follow-up",
      status: "pending",
    };
    request.mockImplementation(async (path: string) => {
      if (path === "learning/journey") return [];
      if (path === "learning/settings")
        return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
      if (path === "learning/reject")
        return {
          proposal: { ...board, status: "rejected" },
          conflict: {
            before: "",
            applied: "board-a",
            current: LEFT_OPEN,
            expectedRevision: 0,
            code: "board-left-open",
          },
        };
      return {
        reviews: [],
        proposals: [board],
        pendingCount: 1,
        appliedThisWeek: 0,
        botNames: {},
      };
    });
    const container = document.createElement("div"),
      root = createRoot(container);
    try {
      await act(async () => root.render(createElement(Learning)));
      i18n.locale = locale;
      i18n.messages = messages;
      await act(async () =>
        [...container.querySelectorAll("button")].find((b) => b.textContent === "Reject")!.click(),
      );
      expect(container.textContent).toContain(translated);
      expect(container.textContent).not.toContain(LEFT_OPEN);
      expect(messages[LEFT_OPEN]).toBe(translated);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it.each([
  ["ru", RU_MESSAGES, "Эта задача на доске изменилась после создания. Проверьте её на доске."],
  ["zh-CN", ZH_MESSAGES, "此看板事项在创建后已有变更。请在看板上查看。"],
] as const)(
  "renders the Undo board-changed sentence from the %s catalog",
  async (locale, messages, translated) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const board = {
      ...proposal,
      type: "board-item",
      proposedContent: undefined,
      boardItem: {
        title: "Finish the import follow-up",
        description: "The run stopped before the import finished.",
        acceptanceCriteria: "The import completes.",
      },
      diff: "+Finish the import follow-up",
      status: "applied",
      appliedBoardItem: {
        workspaceId: "workspace",
        itemId: "board-a",
        updatedAt: "2026-09-25T12:00:00.000Z",
        duplicate: false,
      },
    };
    const current = "This board item changed after it was filed. Review it on the Board.";
    request.mockImplementation(async (path: string) => {
      if (path === "learning/journey") return [];
      if (path === "learning/settings")
        return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
      if (path === "learning/revert")
        return {
          proposal: board,
          conflict: {
            before: "",
            applied: "board-a",
            current,
            expectedRevision: 0,
            code: "board-changed",
          },
        };
      return {
        reviews: [],
        proposals: [board],
        pendingCount: 0,
        appliedThisWeek: 1,
        botNames: {},
      };
    });
    const container = document.createElement("div"),
      root = createRoot(container);
    try {
      await act(async () => root.render(createElement(Learning)));
      i18n.locale = locale;
      i18n.messages = messages;
      await act(async () =>
        [...container.querySelectorAll("button")].find((b) => b.textContent === "Undo")!.click(),
      );
      expect(container.textContent).toContain(translated);
      expect(container.textContent).not.toContain(current);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("falls back to the server sentence for an unknown board conflict code", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    diff: "+Finish the import follow-up",
    status: "pending",
  };
  const current = "Kept for review on the Board.";
  request.mockImplementation(async (path: string) => {
    if (path === "learning/journey") return [];
    if (path === "learning/settings")
      return { enabled: true, reviewerPin: null, destination: null, budgets: {} };
    if (path === "learning/reject")
      return {
        proposal: { ...board, status: "rejected" },
        conflict: {
          before: "",
          applied: "board-a",
          current,
          expectedRevision: 0,
          code: "board-other",
        },
      };
    return { reviews: [], proposals: [board], pendingCount: 1, appliedThisWeek: 0, botNames: {} };
  });
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Learning)));
    i18n.locale = "ru";
    i18n.messages = RU_MESSAGES;
    await act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Reject")!.click(),
    );
    expect(container.textContent).toContain(current);
    expect(container.textContent).not.toContain(
      "Эта задача на доске изменилась после создания, поэтому она оставлена открытой для проверки на доске.",
    );
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

it("only trusts a message the server actually sent, and falls back for a transport failure", () => {
  const fallback = "Could not update learning. Try again.";
  expect(
    actionMessage(
      new RpcServerError("This bot cannot reach this board's computer.", "FORBIDDEN"),
      fallback,
    ),
  ).toBe("This bot cannot reach this board's computer.");
  // The body a real server sends for an error it did not map, such as a suggestion that another
  // device already handled.
  expect(
    actionMessage(new RpcServerError("Internal server error", "INTERNAL_SERVER_ERROR"), fallback),
  ).toBe(fallback);
  expect(
    actionMessage(new RpcServerError("connect ECONNREFUSED", "INTERNAL_SERVER_ERROR"), fallback),
  ).toBe(fallback);
  // A user-facing code with no sentence of its own, and a message with no code at all.
  expect(actionMessage(new RpcServerError("Forbidden", "FORBIDDEN"), fallback)).toBe(fallback);
  expect(actionMessage(new RpcServerError("Something broke"), fallback)).toBe(fallback);
  // A native fetch failure when the phone is offline.
  expect(actionMessage(new Error("Network request failed"), fallback)).toBe(fallback);
  // The client's own abort timer.
  expect(actionMessage(new Error("Request timed out"), fallback)).toBe(fallback);
  // A response with no message at all.
  expect(actionMessage(new Error("rpc learning/reject failed"), fallback)).toBe(fallback);
  expect(actionMessage("not an error", fallback)).toBe(fallback);
});
