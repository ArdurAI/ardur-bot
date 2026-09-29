// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import type { UsageSummary } from "@ardurbot/contracts";
import UsagePanel from "./UsagePanel";

const period = {
  records: 1,
  inputTokens: 120,
  outputTokens: 1,
  cost: null,
};
const summary = (incomplete: boolean | undefined): UsageSummary => ({
  inputTokens: 120,
  outputTokens: 1,
  runs: 1,
  dayStart: "2026-09-24T00:00:00Z",
  weekStart: "2026-09-21T00:00:00Z",
  asOf: "2026-09-24T12:00:00Z",
  providers: [
    {
      provider: "anthropic",
      today: { ...period, ...(incomplete === undefined ? {} : { incomplete }) },
      week: { ...period, incomplete: false },
      daily: [{ date: "2026-09-24", records: 1, tokens: 121 }],
    },
  ],
});

async function render(data: UsageSummary) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<UsagePanel data={data} />));
  return { container, root };
}

it("shows Partially reported when a period's totals are only a lower bound", async () => {
  const { container, root } = await render(summary(true));
  expect(container.textContent).toContain("Partially reported");
  expect(container.textContent).toContain("121 tokens");
  await act(async () => root.unmount());
});

it("omits the marker when every period total was fully reported", async () => {
  for (const incomplete of [false, undefined] as const) {
    const { container, root } = await render(summary(incomplete));
    expect(container.textContent).not.toContain("Partially reported");
    await act(async () => root.unmount());
  }
});
