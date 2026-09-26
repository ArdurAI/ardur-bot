// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { ORPCError } from "@orpc/client";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const i18n = vi.hoisted(() => ({
  locale: "en",
  messages: {} as Record<string, string>,
}));

const api = vi.hoisted(() => ({
  list: vi.fn(),
  proposal: vi.fn(),
  summary: vi.fn(),
  settings: vi.fn(),
  grants: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  edit: vi.fn(),
  revert: vi.fn(),
  evidence: vi.fn(),
  configure: vi.fn(),
  observation: vi.fn(),
  journey: vi.fn(),
  curator: vi.fn(),
  curate: vi.fn(),
  skillCare: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { learning: api } }));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => {
    if (typeof children !== "string" || i18n.locale === "en") return children;
    const text = children.replace(/\s+/g, " ").trim();
    return i18n.messages[text] || children;
  },
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.reduce((message, part, i) => message + part + (values[i] ?? ""), "");
      if (i18n.locale === "en") return text;
      return i18n.messages[text] || text;
    },
    i18n: {
      _: ({ message }: { message: string }) =>
        i18n.locale === "en" ? message : i18n.messages[message] || message,
    },
  }),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      {...props}
    />
  ),
}));

import { LearningInbox } from "./LearningInbox";

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
  rationale: "The owner requested a reusable format.",
  expectedBaseRevision: 0,
  evidenceIds: ["source"],
  confidence: { label: "model estimate", value: 0.8 },
  diff: "--- current\n+++ proposed\n-\n+Use numbered steps.",
  expiresAt: "2099-01-01T00:00:00.000Z",
  status: "pending",
};
let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api.list.mockResolvedValue({
    reviews: [],
    proposals: [proposal],
    pendingCount: 3,
    appliedThisWeek: 0,
  });
  api.summary.mockImplementation(() => api.list());
  api.settings.mockResolvedValue({ enabled: true, canConfigure: false });
  api.grants.mockResolvedValue({ grants: [], offers: [] });
  api.journey.mockResolvedValue([]);
  api.curator.mockResolvedValue({ reports: [], skills: [] });
  api.observation.mockResolvedValue(observation);
  api.proposal.mockResolvedValue(proposal);
});
it("opens an older timeline proposal even when it is outside the inbox page", async () => {
  api.list.mockResolvedValue({ reviews: [], proposals: [], pendingCount: 0, appliedThisWeek: 0 });
  api.journey.mockResolvedValue([
    {
      id: "audit:old",
      at: "2026-09-01T00:00:00Z",
      action: "curator-policy",
      proposalId: proposal.id,
    },
  ]);
  await act(async () => root.render(<LearningInbox botId="bot" />));
  await click("Proposal");
  expect(api.proposal).toHaveBeenCalledWith({ proposalId: proposal.id });
  expect(container.querySelector("article details")?.hasAttribute("open")).toBe(true);
  expect(container.textContent).toContain(proposal.proposedContent);
});
afterEach(async () => {
  i18n.locale = "en";
  i18n.messages = {};
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const LEFT_OPEN =
  "This board item changed after it was filed, so it was left open for review on the Board.";
const BOARD_CHANGED = "This board item changed after it was filed. Review it on the Board.";

function catalogTranslation(locale: string, msgid: string) {
  const catalog = readFileSync(
    path.join(import.meta.dirname, "../locales", locale, "messages.po"),
    "utf8",
  );
  const key = `msgid ${JSON.stringify(msgid)}\nmsgstr "`;
  const at = catalog.indexOf(key);
  if (at < 0) return "";
  const start = at + key.length;
  const end = catalog.indexOf('"', start);
  return catalog.slice(start, end);
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
it("separates pending copy from applied copy, approves without removing the card, and undoes", async () => {
  await act(async () => root.render(<LearningInbox botId="bot" />));
  expect(container.textContent).toContain("3 suggestions to review");
  expect(container.textContent).not.toContain("learned 3 things");
  const card = container.querySelector("article");
  const applied = {
    ...proposal,
    status: "applied",
    documentId: "document",
    appliedRevisionId: "document:1",
  };
  api.approve.mockImplementation(async () => {
    api.list.mockResolvedValue({
      reviews: [],
      proposals: [applied],
      pendingCount: 0,
      appliedThisWeek: 1,
    });
    return { proposal: applied };
  });
  await click("Approve");
  expect(api.approve).toHaveBeenCalledWith({ proposalId: "proposal" });
  expect(container.querySelector("article")).toBe(card);
  expect(container.textContent).toContain("learned 1 things this week");
  expect(container.textContent).toContain("Applied");
  await act(async () => {
    const details = container.querySelector("article details")! as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle", { bubbles: true }));
  });
  expect(container.textContent).toContain("Not enough runs to tell");
  expect(container.textContent).toContain("No feedback is not approval");
  expect(api.observation).toHaveBeenCalledWith({ documentId: "document", revision: 1 });
  api.revert.mockImplementation(async () => {
    api.list.mockResolvedValue({
      reviews: [],
      proposals: [{ ...applied, status: "reverted" }],
      pendingCount: 0,
      appliedThisWeek: 0,
    });
    return { proposal: { ...applied, status: "reverted" } };
  });
  await click("Undo");
  expect(api.revert).toHaveBeenCalledWith({ proposalId: "proposal" });
  expect(container.textContent).toContain("Undone");
});
it("shows every field Approve will file for a board item, including labels", async () => {
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
  api.list.mockResolvedValue({
    reviews: [],
    proposals: [board],
    pendingCount: 1,
    appliedThisWeek: 0,
  });
  await act(async () => root.render(<LearningInbox botId="bot" />));
  await act(async () => {
    const details = container.querySelector("article details")! as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle", { bubbles: true }));
  });
  expect(container.textContent).toContain("bug, import");
});
it("shows the board service's own sentence when Approve cannot file the item, not the generic retry text", async () => {
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
  api.list.mockResolvedValue({
    reviews: [],
    proposals: [board],
    pendingCount: 1,
    appliedThisWeek: 0,
  });
  api.approve.mockRejectedValue(
    new ORPCError("FORBIDDEN", { message: "This bot cannot reach this board's computer." }),
  );
  await act(async () => root.render(<LearningInbox botId="bot" />));
  await click("Approve");
  expect(container.querySelector("[role=alert]")?.textContent).toContain(
    "This bot cannot reach this board's computer.",
  );
  expect(container.textContent).not.toContain("Could not update learning. Try again.");
});
it("shows the translated retry sentence, never the server's own text, for an error it did not map", async () => {
  api.list.mockResolvedValue({
    reviews: [],
    proposals: [proposal],
    pendingCount: 1,
    appliedThisWeek: 0,
  });
  // The body a real server sends when Approve throws a plain Error, such as a suggestion that
  // another tab already handled.
  api.approve.mockRejectedValue(
    new ORPCError("INTERNAL_SERVER_ERROR", { message: "Internal server error", status: 500 }),
  );
  await act(async () => root.render(<LearningInbox botId="bot" />));
  await click("Approve");
  expect(container.querySelector("[role=alert]")?.textContent).toContain(
    "Could not update learning. Try again.",
  );
  expect(container.textContent).not.toContain("Internal server error");
});
it("shows Closing on the Board until the pending close clears", async () => {
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    status: "rejected",
    boardClosing: true,
  };
  api.list.mockResolvedValue({
    reviews: [],
    proposals: [board],
    pendingCount: 0,
    appliedThisWeek: 0,
  });
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<LearningInbox botId="bot" />));
    expect(container.textContent).toContain("Closing on the Board.");
    expect(catalogTranslation("ru", "Closing on the Board.")).toBe("Закрывается на доске.");
    expect(catalogTranslation("zh-CN", "Closing on the Board.")).toBe("正在看板上关闭。");
    api.list.mockResolvedValue({
      reviews: [],
      proposals: [{ ...board, boardClosing: false }],
      pendingCount: 0,
      appliedThisWeek: 0,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(container.textContent).toContain("Rejected");
    expect(container.textContent).not.toContain("Closing on the Board.");
  } finally {
    vi.useRealTimers();
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
};
it("shows Closing on the Board as soon as Reject answers with the closing code", async () => {
  api.list.mockResolvedValueOnce({
    reviews: [],
    proposals: [pendingBoard],
    pendingCount: 1,
    appliedThisWeek: 0,
  });
  await act(async () => root.render(<LearningInbox botId="bot" />));
  // The reload after Reject has not answered yet.
  api.list.mockReturnValue(new Promise(() => undefined));
  api.reject.mockResolvedValue({
    proposal: { ...pendingBoard, status: "rejected" },
    code: "board-closing",
  });
  await click("Reject");
  expect(container.textContent).toContain("Closing on the Board.");
  expect(container.textContent).not.toContain("Approve");
});
it("says a board close that keeps failing could not be closed, and what to do", async () => {
  api.list.mockResolvedValue({
    reviews: [],
    proposals: [
      { ...pendingBoard, status: "rejected", boardClosing: true, boardCloseFailed: true },
    ],
    pendingCount: 0,
    appliedThisWeek: 0,
  });
  await act(async () => root.render(<LearningInbox botId="bot" />));
  expect(container.textContent).toContain("A board item filed by a bot could not be closed.");
  expect(container.textContent).toContain(
    "Ardur Bot tried five times. Close it on the Board, or check that this computer is connected.",
  );
  expect(container.textContent).not.toContain("Closing on the Board.");
  expect(catalogTranslation("ru", "A board item filed by a bot could not be closed.")).not.toBe("");
  expect(
    catalogTranslation(
      "zh-CN",
      "Ardur Bot tried five times. Close it on the Board, or check that this computer is connected.",
    ),
  ).not.toBe("");
});
it("shows the changed sentence after a pending close was left with the person", async () => {
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    status: "rejected",
    boardChanged: true,
  };
  api.list.mockResolvedValue({
    reviews: [],
    proposals: [board],
    pendingCount: 0,
    appliedThisWeek: 0,
  });
  await act(async () => root.render(<LearningInbox botId="bot" />));
  expect(container.textContent).toContain(
    "This board item changed after it was filed. Review it on the Board.",
  );
  expect(container.textContent).not.toContain("Closing on the Board.");
  expect(
    catalogTranslation("ru", "This board item changed after it was filed. Review it on the Board."),
  ).toBe("Эта задача на доске изменилась после создания. Проверьте её на доске.");
});
it("says a board item was closed without being completed and what to do", async () => {
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    status: "applied",
    appliedBoardItem: {
      workspaceId: "workspace",
      itemId: "board-a",
      updatedAt: "2026-09-25T12:00:00.000Z",
      duplicate: false,
    },
    boardOutcome: {
      closedAt: "2026-09-25T13:00:00.000Z",
      outcome: "closed-other" as const,
      closeReason: "No longer needed",
    },
  };
  const quiet = {
    ...board,
    id: "quiet",
    boardOutcome: {
      closedAt: "2026-09-25T13:00:00.000Z",
      outcome: "closed-other" as const,
      closeReason: null,
    },
  };
  api.list.mockResolvedValue({
    reviews: [],
    proposals: [board, quiet],
    pendingCount: 0,
    appliedThisWeek: 1,
  });
  await act(async () => root.render(<LearningInbox botId="bot" />));
  expect(container.textContent).toContain(
    "This board item was closed without being completed: No longer needed. Review it on the Board.",
  );
  expect(container.textContent).toContain(
    "This board item was closed without being completed. Review it on the Board.",
  );
  expect(container.textContent).not.toContain("closed otherwise");
});
it("says what happened when a filed board item changed before Undo", async () => {
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    status: "applied",
    appliedBoardItem: {
      workspaceId: "workspace",
      itemId: "board-a",
      updatedAt: "2026-09-25T12:00:00.000Z",
      duplicate: false,
    },
  };
  api.list.mockResolvedValue({
    reviews: [],
    proposals: [board],
    pendingCount: 0,
    appliedThisWeek: 1,
  });
  api.revert.mockResolvedValue({
    proposal: board,
    conflict: { before: "", applied: "board-a", current: "", expectedRevision: 0 },
  });
  await act(async () => root.render(<LearningInbox botId="bot" />));
  await click("Undo");
  expect(container.querySelector("article [role=alert]")?.textContent).toBe(
    "This board item changed after it was filed. Review it on the Board.",
  );
});
it("shows the server sentence when Reject leaves a changed board item open", async () => {
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    status: "pending",
  };
  const sentence =
    "This board item changed after it was filed, so it was left open for review on the Board.";
  api.list.mockResolvedValue({
    reviews: [],
    proposals: [board],
    pendingCount: 1,
    appliedThisWeek: 0,
  });
  api.reject.mockImplementation(async () => {
    api.list.mockResolvedValue({
      reviews: [],
      proposals: [{ ...board, status: "rejected" }],
      pendingCount: 0,
      appliedThisWeek: 0,
    });
    return {
      proposal: { ...board, status: "rejected" },
      conflict: { before: "", applied: "board-a", current: sentence, expectedRevision: 0 },
    };
  });
  await act(async () => root.render(<LearningInbox botId="bot" />));
  await click("Reject");
  expect(container.querySelector("article [role=alert]")?.textContent).toContain(sentence);
  expect(container.textContent).not.toContain(
    "This board item changed after it was filed. Review it on the Board.",
  );
});
it.each([
  [
    "ru",
    "Эта задача на доске изменилась после создания, поэтому она оставлена открытой для проверки на доске.",
  ],
  ["zh-CN", "此看板事项在创建后已有变更，因此仍保持开放，供在看板上复查。"],
] as const)(
  "renders the left-open Reject sentence from the %s catalog",
  async (locale, translated) => {
    const board = {
      ...proposal,
      type: "board-item",
      proposedContent: undefined,
      boardItem: {
        title: "Finish the import follow-up",
        description: "The run stopped before the import finished.",
        acceptanceCriteria: "The import completes.",
      },
      status: "pending",
    };
    api.list.mockResolvedValue({
      reviews: [],
      proposals: [board],
      pendingCount: 1,
      appliedThisWeek: 0,
    });
    api.reject.mockResolvedValue({
      proposal: { ...board, status: "rejected" },
      conflict: {
        before: "",
        applied: "board-a",
        current: LEFT_OPEN,
        expectedRevision: 0,
        code: "board-left-open",
      },
    });
    await act(async () => root.render(<LearningInbox botId="bot" />));
    i18n.locale = locale;
    i18n.messages = { [LEFT_OPEN]: catalogTranslation(locale, LEFT_OPEN) };
    await click("Reject");
    expect(container.querySelector("article [role=alert]")?.textContent).toBe(translated);
  },
);

it.each([
  ["ru", "Эта задача на доске изменилась после создания. Проверьте её на доске."],
  ["zh-CN", "此看板事项在创建后已有变更。请在看板上查看。"],
] as const)(
  "renders the Undo board-changed sentence from the %s catalog",
  async (locale, translated) => {
    const board = {
      ...proposal,
      type: "board-item",
      proposedContent: undefined,
      boardItem: {
        title: "Finish the import follow-up",
        description: "The run stopped before the import finished.",
        acceptanceCriteria: "The import completes.",
      },
      status: "applied",
      appliedBoardItem: {
        workspaceId: "workspace",
        itemId: "board-a",
        updatedAt: "2026-09-25T12:00:00.000Z",
        duplicate: false,
      },
    };
    api.list.mockResolvedValue({
      reviews: [],
      proposals: [board],
      pendingCount: 0,
      appliedThisWeek: 1,
    });
    api.revert.mockResolvedValue({
      proposal: board,
      conflict: {
        before: "",
        applied: "board-a",
        current: BOARD_CHANGED,
        expectedRevision: 0,
        code: "board-changed",
      },
    });
    await act(async () => root.render(<LearningInbox botId="bot" />));
    i18n.locale = locale;
    i18n.messages = { [BOARD_CHANGED]: catalogTranslation(locale, BOARD_CHANGED) };
    await click("Undo");
    expect(container.querySelector("article [role=alert]")?.textContent).toBe(translated);
  },
);

it("falls back to the server sentence for an unknown board conflict code", async () => {
  const board = {
    ...proposal,
    type: "board-item",
    proposedContent: undefined,
    boardItem: {
      title: "Finish the import follow-up",
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
    },
    status: "pending",
  };
  const current = "Kept for review on the Board.";
  api.list.mockResolvedValue({
    reviews: [],
    proposals: [board],
    pendingCount: 1,
    appliedThisWeek: 0,
  });
  api.reject.mockResolvedValue({
    proposal: { ...board, status: "rejected" },
    conflict: { before: "", applied: "board-a", current, expectedRevision: 0, code: "board-other" },
  });
  await act(async () => root.render(<LearningInbox botId="bot" />));
  i18n.locale = "ru";
  i18n.messages = {
    [LEFT_OPEN]:
      "Эта задача на доске изменилась после создания, поэтому она оставлена открытой для проверки на доске.",
  };
  await click("Reject");
  expect(container.querySelector("article [role=alert]")?.textContent).toBe(current);
});

it("disables display-only approval with a sentence and does not fetch evidence until opened", async () => {
  api.list.mockResolvedValue({
    reviews: [],
    proposals: [{ ...proposal, type: "pin-insight" }],
    pendingCount: 1,
    appliedThisWeek: 0,
  });
  await act(async () => root.render(<LearningInbox />));
  expect(
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Approve")
      ?.disabled,
  ).toBe(true);
  expect(container.textContent).toContain("This suggestion cannot be approved here yet.");
  expect(api.evidence).not.toHaveBeenCalled();
  api.evidence.mockResolvedValue({
    sourceClass: "human-message",
    runId: "run",
    excerpt: "A scoped instruction",
  });
  await click("Evidence source");
  expect(api.evidence).toHaveBeenCalledWith({ proposalId: "proposal", evidenceId: "source" });
});
it("shows the empty state and permits only the owner to enable learning", async () => {
  api.list.mockResolvedValue({ reviews: [], proposals: [], pendingCount: 0, appliedThisWeek: 0 });
  api.settings.mockResolvedValue({ enabled: false, canConfigure: false });
  await act(async () => root.render(<LearningInbox />));
  expect(container.textContent).toContain("Nothing to review.");
  expect(container.textContent).toContain("Learning is off for this space.");
  expect(container.querySelector("input")).toBeNull();
});
it("sends edited content for a server diff before approval", async () => {
  await act(async () => root.render(<LearningInbox />));
  await click("Edit");
  await click("Save");
  expect(api.edit).toHaveBeenCalledWith({
    proposalId: "proposal",
    edits: { proposedContent: "Use numbered steps." },
  });
  expect(api.approve).not.toHaveBeenCalled();
});
