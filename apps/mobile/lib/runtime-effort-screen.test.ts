// @vitest-environment jsdom
import type { Bot, RuntimePin } from "@ardurbot/contracts";
import { modelPinOptionKey } from "@ardurbot/core";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BotRuntimeLabel } from "../components/bot-runtime-label";
import { RuntimeSettings } from "../components/runtime-settings";
import { rpc } from "./api";
import { presentMessageActionSheet } from "./message-action-sheet";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}), useResolvedAppearance: () => "light" }));
vi.mock("react-native", () => ({
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "aria-label": accessibilityLabel },
      children,
    ),
  Switch: () => null,
  Linking: { openURL: vi.fn() },
}));
const pin: RuntimePin = {
  runtimeKind: "claude-code",
  provider: "anthropic",
  modelId: "claude-opus-5",
  effort: "high",
  credentialId: "native:claude-code",
  revision: 1,
};
const bot = {
  runtimeKind: pin.runtimeKind,
  modelProvider: pin.provider,
  modelId: pin.modelId,
  thinkingLevel: pin.effort,
  modelCredentialId: pin.credentialId,
  modelPinRevision: pin.revision,
} as Bot;

it.each([false, true, undefined])(
  "matches the header effort suffix for evidence %s",
  async (effortAttested) => {
    const node = document.createElement("div");
    const root = createRoot(node);
    const run = { runtimePin: pin, runtimeInfo: { runtimeKind: pin.runtimeKind, effortAttested } };
    await act(async () => root.render(createElement(BotRuntimeLabel, { bot, run })));
    expect(node.textContent).toBe(`Claude Code · high${effortAttested ? "" : " · requested"}`);
    await act(async () =>
      root.render(createElement(BotRuntimeLabel, { bot: { ...bot, modelPinRevision: 2 }, run })),
    );
    expect(node.textContent).toBe("Claude Code · high · requested");
    await act(async () => root.unmount());
  },
);

it("offers and selects the probed efforts through the native Thinking sheet", async () => {
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  vi.mocked(rpc).mockResolvedValue({
    runtimeKind: "claude-code",
    available: true,
    version: "2.1.281",
    models: [{ id: pin.modelId, label: "Opus 5", efforts }],
  });
  const onEffort = vi.fn();
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      createElement(RuntimeSettings, {
        kind: "claude-code",
        onKind: vi.fn(),
        modelKey: modelPinOptionKey(pin.provider!, pin.modelId!, pin.credentialId!),
        onModel: vi.fn(),
        effort: "low",
        onEffort,
        experimental: true,
        onExperimental: vi.fn(),
      }),
    ),
  );
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Thinking"]')!.click());
  const sheet = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0];
  expect(sheet.actions.map((action) => action.text)).toEqual(efforts);
  sheet.actions.find((action) => action.text === "high")!.onPress();
  expect(onEffort).toHaveBeenCalledWith("high");
  await act(async () => root.unmount());
});
