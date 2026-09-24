// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  summary: vi.fn(),
  settings: vi.fn(),
  grants: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  edit: vi.fn(),
  revert: vi.fn(),
  evidence: vi.fn(),
  configure: vi.fn(),
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
  expect(container.textContent).toContain("no observations yet");
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
