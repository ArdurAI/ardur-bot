// @vitest-environment jsdom
import type { Brief } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ContextSection, MobileBrief, MobileRunContext } from "../components/context-section";
import { rpc } from "./api";
import { loadContext } from "./context";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (key: string, values: Record<string, string> = {}) =>
      Object.entries(values).reduce(
        (text, [key, value]) => text.replace(`{${key}}`, value),
        ZH_MESSAGES[key] ?? key,
      ),
  }),
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}), useResolvedAppearance: () => "light" }));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, children),
}));
const brief: Brief = {
  botId: "chief",
  groupId: "alpha",
  groupName: null,
  threadId: "thread",
  documentId: "document",
  revision: 2,
  content: "## Goal\nRelease Alpha",
  rewrittenAt: "2026-09-24T12:00:00Z",
  reason: "Model unavailable",
};
it("renders the brief read-only and translates labels and maintenance reasons", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(createElement(MobileBrief, { brief })));
  expect(node.textContent).toContain(ZH_MESSAGES["Group brief"]);
  await act(async () => node.querySelector("button")!.click());
  expect(node.textContent).toContain("Release Alpha");
  expect(node.textContent).toContain(ZH_MESSAGES["Model unavailable"]);
  expect(node.querySelector("textarea,input")).toBeNull();
  expect(node.querySelectorAll("button")).toHaveLength(1);
  for (const dictionary of [ZH_MESSAGES, RU_MESSAGES])
    for (const key of [
      "Brief",
      "Group brief",
      "Routed by default",
      "Concurrent runs",
      "Context",
      "Time to first token",
      "Cache hits",
      "Queue wait",
      "Rewritten {time}",
      "Left unchanged: {reason}",
      "Coordinator",
    ])
      expect(dictionary[key]).toBeTruthy();
  await act(async () => root.render(createElement(MobileRunContext, { routingRule: "default" })));
  expect(node.textContent).toBe(ZH_MESSAGES["Routed by default"]);
  await act(async () => root.unmount());
});
it("loads scoped context through the shared schemas and does not render unknown values as zero", async () => {
  vi.mocked(rpc).mockImplementation(async (procedure) =>
    procedure === "briefs/list"
      ? [brief]
      : procedure === "metrics/context"
        ? { today: [], sevenDays: [] }
        : { budgets: {}, concurrentRuns: 3, spaceConcurrentRuns: 3, coordinatorBotId: null },
  );
  expect((await loadContext("chief", "alpha")).briefs).toEqual([brief]);
  expect(rpc).toHaveBeenCalledWith("briefs/list", { botId: "chief", groupId: "alpha" });
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(createElement(ContextSection, { botId: "chief", groupId: "alpha" })),
  );
  await act(async () => node.querySelector("button")!.click());
  expect(node.textContent).toContain(ZH_MESSAGES["Concurrent runs"]);
  expect(node.textContent).toContain("—");
  expect(node.textContent).not.toContain("0%");
  await act(async () => root.unmount());
});
