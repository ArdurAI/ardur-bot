import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  Input: () => null,
  NativeSelect: () => null,
  NativeSelectOption: () => null,
  BotAvatar: () => null,
}));

import { GroupGoalStrip } from "./GroupPanel";

it("shows an exhausted goal as terminal with no Stop action", () => {
  const html = renderToStaticMarkup(
    <GroupGoalStrip
      goal={
        {
          status: "exhausted",
          usedTokens: 600,
          tokenLimit: 600,
          untilAt: "2030-01-01T00:00:00.000Z",
        } as never
      }
      onStop={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  expect(html).toContain("Exhausted");
  expect(html).not.toContain("<button");
});

it("shows review panel for completed goal", () => {
  const html = renderToStaticMarkup(
    <GroupGoalStrip
      goal={
        {
          status: "completed",
          usedTokens: 600,
          tokenLimit: 600,
          untilAt: "2030-01-01T00:00:00.000Z",
          currentRevision: {
            id: "rev-1",
            summary: "Done work",
            conditions: [{ id: "cond-1", description: "check", status: "pass" }],
          },
        } as never
      }
      onStop={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  expect(html).toContain("Review result");
  expect(html).toContain("Done work");
  expect(html).toContain("Accept result");
  expect(html).toContain("Reject result");
  expect(html).toContain("check");
  expect(html).toContain("Pass");
});

it("shows the project plan next step first with owner, status and blockers", () => {
  const html = renderToStaticMarkup(
    <GroupGoalStrip
      goal={
        {
          status: "running",
          usedTokens: 120,
          tokenLimit: 600,
          untilAt: "2030-01-01T00:00:00.000Z",
          plan: {
            revision: 2,
            steps: [
              {
                id: "step-draft",
                title: "Draft the report",
                ownerId: "bot-writer",
                ownerIsUser: false,
                condition: "Draft saved",
                status: "done",
                prerequisiteIds: [],
                outcome: null,
                dispatch: null,
                updatedAt: "2030-01-01T00:00:00.000Z",
              },
              {
                id: "step-review",
                title: "Review the draft",
                ownerId: "bot-reviewer",
                ownerIsUser: false,
                condition: "Notes posted",
                status: "pending",
                prerequisiteIds: ["step-draft"],
                outcome: null,
                dispatch: null,
                updatedAt: "2030-01-01T00:00:00.000Z",
              },
              {
                id: "step-approve",
                title: "Approve the result",
                ownerId: "owner-1",
                ownerIsUser: true,
                condition: "Signed off",
                status: "blocked",
                prerequisiteIds: ["step-review", "step-draft"],
                outcome: null,
                dispatch: null,
                updatedAt: "2030-01-01T00:00:00.000Z",
              },
            ],
          },
        } as never
      }
      members={
        [
          { botId: "bot-writer", name: "Writer" },
          { botId: "bot-reviewer", name: "Reviewer" },
        ] as never
      }
      onStop={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  expect(html).toContain("Plan");
  expect(html).toContain("Review the draft");
  expect(html).toContain("Reviewer");
  expect(html).toContain("Approve the result");
  expect(html).toContain("You");
  expect(html).toContain("Blocked");
  expect(html).toContain("Waiting for");
  // The ready step sorts before the blocked one; done sorts last.
  expect(html.indexOf("Review the draft")).toBeLessThan(html.indexOf("Approve the result"));
  expect(html.indexOf("Approve the result")).toBeLessThan(html.indexOf("Draft the report"));
});

it.each(["pending", "active"])("shows a pending step waiting on a %s prerequisite", (status) => {
  const html = renderToStaticMarkup(
    <GroupGoalStrip
      goal={
        {
          status: "running",
          usedTokens: 0,
          tokenLimit: 600,
          untilAt: "2030-01-01T00:00:00.000Z",
          plan: {
            revision: 2,
            steps: [
              {
                id: "draft",
                title: "Draft report",
                ownerId: "writer",
                status,
                prerequisiteIds: [],
              },
              {
                id: "done",
                title: "Earlier work",
                ownerId: "writer",
                status: "done",
                prerequisiteIds: [],
              },
              {
                id: "review",
                title: "Review report",
                ownerId: "reviewer",
                status: "pending",
                prerequisiteIds: ["draft", "done"],
              },
            ],
          },
        } as never
      }
      onStop={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  expect(html).toContain("Waiting for Draft report");
  expect(html).not.toContain("Waiting for Draft report, Earlier work");
  expect(html).toContain("Pending");
  expect(html).not.toContain("Blocked");
});
