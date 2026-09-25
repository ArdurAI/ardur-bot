// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
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
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
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
