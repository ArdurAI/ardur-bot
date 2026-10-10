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
    />,
  );
  expect(html).toContain("Review result");
  expect(html).toContain("Done work");
  expect(html).toContain("Accept result");
  expect(html).toContain("Reject result");
  expect(html).toContain("check");
  expect(html).toContain("Pass");
});
