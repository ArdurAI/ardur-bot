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
