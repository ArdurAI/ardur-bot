import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

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
