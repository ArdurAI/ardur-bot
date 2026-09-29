// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("../../lib/rpc", () => ({ rpc: { learning: {} } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((message, part, i) => message + part + (values[i] ?? ""), ""),
  }),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
}));

import LearningPanel from "./LearningPanel";

it("shows Insights beside Inbox only when there are insights", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const openLearning = vi.fn();
  const data = { reviews: [], proposals: [], botNames: {}, pendingCount: 2, appliedThisWeek: 0 };
  const render = (insightCount: number) =>
    act(async () =>
      root.render(
        <LearningPanel
          data={{ ...data, insightCount }}
          openLearning={openLearning}
          openSettings={vi.fn()}
          refresh={vi.fn(async () => undefined)}
        />,
      ),
    );
  await render(0);
  expect(container.textContent).toContain("Inbox (2)");
  expect(container.textContent).not.toContain("Insights");
  await render(3);
  const insights = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Insights (3)",
  );
  await act(async () => insights?.click());
  expect(openLearning).toHaveBeenCalledOnce();
  act(() => root.unmount());
});

it("shows each item's own text and keeps the shared review reason secondary", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const shared = "Imported memory. Review before saving.";
  const memory = (id: string, proposedContent: string) => ({
    id,
    type: "memory" as const,
    operation: "memory-import" as const,
    scope: { spaceId: "space" },
    target: {},
    proposedContent,
    rationale: shared,
    evidenceIds: ["evidence"],
    confidence: { label: "model estimate" as const, value: 0.5 },
    diff: "",
    status: "pending" as const,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  await act(async () =>
    root.render(
      <LearningPanel
        data={{
          reviews: [],
          proposals: [
            memory("one", "Helm chart release mechanics and gotchas"),
            memory("two", "Daily notes stay on this computer."),
          ],
          botNames: {},
          pendingCount: 2,
          appliedThisWeek: 0,
          insightCount: 0,
        }}
        openLearning={vi.fn()}
        openSettings={vi.fn()}
        refresh={vi.fn(async () => undefined)}
      />,
    ),
  );
  const rows = [...container.querySelectorAll("button")]
    .map((button) => button.textContent ?? "")
    .filter((text) => text.includes(shared));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("Helm chart release mechanics and gotchas");
  expect(rows[1]).toContain("Daily notes stay on this computer.");
  expect(rows[0]).not.toBe(rows[1]);
  act(() => root.unmount());
});

it("counts and lists only items still waiting for a decision", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const memory = (id: string, proposedContent: string, status: "pending" | "rejected") => ({
    id,
    type: "memory" as const,
    operation: "memory-import" as const,
    scope: { spaceId: "space" },
    target: {},
    proposedContent,
    rationale: "Imported memory. Review before saving.",
    evidenceIds: ["evidence"],
    confidence: { label: "model estimate" as const, value: 0.5 },
    diff: "",
    status,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  await act(async () =>
    root.render(
      <LearningPanel
        data={{
          reviews: [],
          proposals: [
            memory("decided", "Already rejected item", "rejected"),
            memory("waiting", "Still waiting item", "pending"),
          ],
          botNames: {},
          pendingCount: 1,
          appliedThisWeek: 0,
          insightCount: 0,
        }}
        openLearning={vi.fn()}
        openSettings={vi.fn()}
        refresh={vi.fn(async () => undefined)}
      />,
    ),
  );
  const text = container.textContent ?? "";
  expect(text).toContain("Inbox (1)");
  expect(text).toContain("Still waiting item");
  expect(text).not.toContain("Already rejected item");
  expect(text).not.toContain("No proposals");
  await act(async () =>
    root.render(
      <LearningPanel
        data={{
          reviews: [],
          proposals: [memory("decided", "Already rejected item", "rejected")],
          botNames: {},
          pendingCount: 0,
          appliedThisWeek: 0,
          insightCount: 0,
        }}
        openLearning={vi.fn()}
        openSettings={vi.fn()}
        refresh={vi.fn(async () => undefined)}
      />,
    ),
  );
  const empty = container.textContent ?? "";
  expect(empty).toContain("Inbox (0)");
  expect(empty).toContain("No proposals");
  expect(empty).not.toContain("Already rejected item");
  act(() => root.unmount());
});
