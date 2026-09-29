// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  BotAvatar: ({ size, label }: { size?: number; label?: string }) => (
    <span data-testid="seal" data-size={size} data-label={label} />
  ),
  Button: ({
    variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button data-variant={variant} {...props} />
  ),
}));

import {
  BotSettingsTitle,
  isSettingsPanel,
  SettingsPanelToggle,
  ThreadSettingsButton,
} from "./settings-chrome";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([
  ["a one-bot thread", false, "Bot settings", "settings"],
  ["a group", true, "Group settings", "group-settings"],
] as const)(
  "opens and closes the settings of %s from the header",
  async (_, group, label, target) => {
    const onPanel = vi.fn();
    const button = () => container.querySelector("button");
    await act(async () =>
      root.render(<ThreadSettingsButton group={group} panel={null} onPanel={onPanel} />),
    );
    expect(button()?.getAttribute("aria-label")).toBe(label);
    expect(button()?.title).toBe(label);
    expect(button()?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => button()?.click());
    expect(onPanel).toHaveBeenLastCalledWith(target);

    await act(async () =>
      root.render(<ThreadSettingsButton group={group} panel="computer" onPanel={onPanel} />),
    );
    await act(async () => button()?.click());
    expect(onPanel).toHaveBeenLastCalledWith(target);

    await act(async () =>
      root.render(<ThreadSettingsButton group={group} panel={target} onPanel={onPanel} />),
    );
    expect(button()?.getAttribute("aria-pressed")).toBe("true");
    expect(button()?.hasAttribute("data-active")).toBe(true);
    await act(async () => button()?.click());
    expect(onPanel).toHaveBeenLastCalledWith(null);
  },
);

it("gives only bot and group settings the wide panel", () => {
  const panels = [
    "settings",
    "group-settings",
    "computer",
    "routine",
    "routines",
    "create",
    "create-group",
    null,
  ];
  expect(panels.filter(isSettingsPanel)).toEqual(["settings", "group-settings"]);
});

it("heads bot settings with the bot's seal and name", async () => {
  await act(async () =>
    root.render(<BotSettingsTitle bot={{ id: "bot", name: "Chief", color: "slate" }} />),
  );
  const seal = container.querySelector('[data-testid="seal"]');
  expect(seal?.getAttribute("data-size")).toBe("28");
  expect(seal?.getAttribute("data-label")).toBe("Chief");
  expect(container.textContent).toBe("Chief");
});

it("fills the panel's settings gear with ink while settings are open", async () => {
  const onToggle = vi.fn();
  const gear = () => container.querySelector("button");
  await act(async () => root.render(<SettingsPanelToggle open onToggle={onToggle} />));
  expect(gear()?.getAttribute("aria-label")).toBe("Show computer");
  expect(gear()?.dataset.variant).toBe("default");
  await act(async () => gear()?.click());
  expect(onToggle).toHaveBeenCalledOnce();

  await act(async () => root.render(<SettingsPanelToggle open={false} onToggle={onToggle} />));
  expect(gear()?.getAttribute("aria-label")).toBe("Show settings");
  expect(gear()?.dataset.variant).toBe("ghost");
});
