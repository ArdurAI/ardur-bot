// @vitest-environment jsdom

import { unknownCapacity } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc: request }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string>) =>
      text.replace("{amount}", values?.amount ?? ""),
  }),
}));
vi.mock("./native", () => ({
  useMobileTokens: () => ({
    foreground: "black",
    mutedForeground: "gray",
    muted: "gray",
    primary: "black",
  }),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) =>
    createElement("div", { role: accessibilityRole }, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
}));

import { FleetStatus } from "../components/fleet-status";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("renders capacity, unknown memory and bot placement without write controls", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockResolvedValue({
    targets: [
      {
        id: "host",
        name: "This Mac",
        state: "connected",
        capacity: { ...unknownCapacity(), memoryFree: 2 * 1024 ** 3, memoryTotal: 8 * 1024 ** 3 },
        bots: [{ id: "bot", name: "Builder" }],
      },
      {
        id: "remote",
        name: "Linux computer",
        state: "unavailable",
        capacity: unknownCapacity(),
        bots: [],
      },
    ],
  });
  const element = document.createElement("div"),
    root = createRoot(element);
  try {
    await act(async () => root.render(createElement(FleetStatus)));
    expect(request).toHaveBeenCalledWith("fleet/list", {});
    expect(element.textContent).toContain("2.0 GB free");
    expect(element.textContent).toContain("Memory not reported");
    expect(element.textContent).toContain("Builder");
    expect(element.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    expect(element.querySelector("button, input, select")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("has translations for every new fleet string", () => {
  for (const catalog of [RU_MESSAGES, ZH_MESSAGES])
    for (const text of [
      "Computers",
      "Could not load computers.",
      "Connected",
      "Available",
      "Unavailable",
      "Memory not reported",
      "{amount} GB free",
      "Free memory",
    ])
      expect(catalog[text]?.trim()).toBeTruthy();
});
