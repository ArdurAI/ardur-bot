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
  insights: vi.fn(async () => ({ insights: [] })),
}));
vi.mock("../lib/rpc", () => ({ rpc: { learning: api } }));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
}));
vi.mock("@lingui/react/macro", () => ({
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replaceAll("#", String(value)),
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((message, part, i) => message + part + (values[i] ?? ""), ""),
    i18n: { _: ({ message }: { message: string }) => message },
  }),
}));

let activeTab = "inbox";
let changeTab: (value: string) => void = () => undefined;
vi.mock("@ardurbot/ui-web", () => ({
  Tabs: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children: ReactNode;
  }) => {
    activeTab = value ?? activeTab;
    changeTab = onValueChange ?? changeTab;
    return <div>{children}</div>;
  },
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ value, children }: { value: string; children: ReactNode }) => (
    <button
      type="button"
      role="tab"
      aria-selected={value === activeTab}
      onClick={() => changeTab(value)}
    >
      {children}
    </button>
  ),
  TabsContent: ({ value, children }: { value: string; children: ReactNode }) =>
    value === activeTab ? <div>{children}</div> : null,
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

const pending = {
  id: "pending",
  type: "memory",
  scope: { spaceId: "space", userId: "user", botId: "bot" },
  target: {},
  proposedContent: "Still waiting.",
  rationale: "The owner requested a reusable format.",
  expectedBaseRevision: 0,
  evidenceIds: ["source"],
  confidence: { label: "model estimate", value: 0.8 },
  diff: "+Still waiting.",
  expiresAt: "2099-01-01T00:00:00.000Z",
  status: "pending",
};
const saved = {
  ...pending,
  id: "saved",
  proposedContent: "Already saved.",
  status: "applied",
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  activeTab = "inbox";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api.list.mockResolvedValue({
    reviews: [],
    proposals: [pending],
    pendingCount: 1,
    appliedThisWeek: 0,
  });
  api.summary.mockImplementation(() => api.list());
  api.settings.mockResolvedValue({ enabled: true, canConfigure: false });
  api.grants.mockResolvedValue({ grants: [], offers: [] });
  api.journey.mockResolvedValue([
    { id: "audit:saved", at: "2026-09-01T00:00:00.000Z", action: "applied", proposalId: saved.id },
  ]);
  api.proposal.mockImplementation(async ({ proposalId }: { proposalId: string }) =>
    proposalId === saved.id ? { ...saved } : { ...pending },
  );
  api.approve.mockResolvedValue({ proposal: { ...pending, status: "applied" } });
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
function selectedTab() {
  return [...container.querySelectorAll('[role="tab"]')].find(
    (tab) => tab.getAttribute("aria-selected") === "true",
  )?.textContent;
}

it("keeps the inbox open after a refresh of a proposal opened from the timeline", async () => {
  await act(async () => root.render(<LearningInbox botId="bot" />));
  await click("Timeline");
  await click("Proposal");
  expect(container.textContent).toContain("Already saved.");
  await click("Inbox");
  expect(selectedTab()).toBe("Inbox");
  expect(container.querySelector('[data-testid="learning-waiting"]')).toBeTruthy();
  await click("Approve");
  expect(selectedTab()).toBe("Inbox");
  expect(container.querySelector('[data-testid="learning-waiting"]')).toBeTruthy();
  expect(container.querySelector('[data-testid="learning-decided"]')).toBeNull();
});

it("shows a reject overlap warning on the inbox while that tab stays open", async () => {
  api.reject.mockImplementation(async () => {
    api.list.mockResolvedValue({
      reviews: [],
      proposals: [{ ...pending, status: "rejected" }],
      pendingCount: 0,
      appliedThisWeek: 0,
    });
    return {
      proposal: { ...pending, status: "rejected" },
      conflict: { before: "before", applied: "applied", current: "current", expectedRevision: 0 },
    };
  });
  await act(async () => root.render(<LearningInbox botId="bot" />));
  expect(selectedTab()).toBe("Inbox");
  await click("Reject");
  const waiting = container.querySelector('[data-testid="learning-waiting"]');
  expect(waiting).toBeTruthy();
  expect(waiting?.querySelector("[role=alert]")?.textContent).toContain(
    "Later edits overlap this change. Review both versions in History.",
  );
  expect(container.querySelector('[data-testid="learning-decided"]')).toBeNull();
  expect(selectedTab()).toBe("Inbox");
});
