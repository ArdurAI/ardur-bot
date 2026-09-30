// @vitest-environment jsdom
import type { ComputerStatus, ComputerUpdate } from "@ardurbot/contracts";
import { COMPUTER_KINDS, COMPUTER_STATES, computerRuntimeSummary } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Alert } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
const releaseInterrupted = vi.hoisted(() => vi.fn(async (_id: string) => {}));
vi.mock("./computer-updates", () => ({ computerUpdates: { releaseInterrupted } }));
vi.mock("./api", () => ({ rpc: request }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./focus-prompt", () => ({ allowFocusPrompt: vi.fn(), scheduleFocusPrompt: vi.fn() }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({ foreground: "black", mutedForeground: "gray", destructive: "red" }),
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Alert: { alert: vi.fn() },
  View: ({ children, testID }: { children: ReactNode; testID?: string }) =>
    createElement("div", { "data-testid": testID }, children),
  ScrollView: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) =>
    createElement("span", { role: accessibilityRole }, children),
  TextInput: ({
    value,
    onChangeText,
    placeholder,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    placeholder: string;
  }) =>
    createElement("input", {
      value,
      placeholder,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", onClick: onPress, disabled }, children),
}));

import NewBot from "../app/new";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { BotRuntimeSettings, RuntimeSummary } from "../components/runtime-summary";

const status = {
  botId: "bot",
  kind: "desktop",
  mode: "dedicated",
  state: "stopped",
} as ComputerStatus;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockReset();
  releaseInterrupted.mockClear();
  vi.mocked(Alert.alert).mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it.each(Object.keys(COMPUTER_KINDS) as ComputerStatus["kind"][])(
  "renders the same execution facts as web for %s",
  async (kind) => {
    const current = { ...status, kind };
    await act(async () => root.render(createElement(RuntimeSummary, { status: current })));
    const facts = computerRuntimeSummary(current)!;
    expect(container.textContent).toContain(facts.location);
    expect(container.textContent).toContain(facts.reach);
    expect(container.textContent).toContain(facts.sharing);
    await act(async () =>
      root.render(createElement(RuntimeSummary, { status: current, mode: "team" })),
    );
    expect(container.textContent).toContain("Bots share files and installed tools");
  },
);
it.each([
  ["team", "Shared with team", "Bots share files and installed tools"],
  ["dedicated", "Only this bot", null],
] as const)("shows only the %s choice's sharing facts", async (mode, label, warning) => {
  await act(async () =>
    root.render(createElement(ComputerModePicker, { value: mode, onChange: vi.fn() })),
  );
  expect(container.textContent).toContain(label);
  if (warning) expect(container.textContent).toContain(warning);
  else expect(container.textContent).not.toContain("Bots share files and installed tools");
});
it("reads the saved pin without booting or changing the computer", async () => {
  request.mockImplementation(async (procedure) => (procedure === "computer/status" ? status : []));
  await act(async () =>
    root.render(createElement(BotRuntimeSettings, { botId: "bot", mode: "dedicated" }, null)),
  );
  expect(container.textContent).toContain("Where this bot runs");
  expect(container.textContent).toContain("Runs as you; can use your files and signed-in tools");
  expect(request.mock.calls.map((call) => call[0])).toEqual([
    "computer/status",
    "computer/connections",
    "computer/updates",
  ]);
});
it("shows the location, sharing choice and consequence once in bot settings", async () => {
  request.mockImplementation(async (procedure) =>
    procedure === "computer/status" ? { ...status, mode: "team" } : [],
  );
  await act(async () =>
    root.render(
      createElement(
        BotRuntimeSettings,
        { botId: "bot", mode: "team" },
        createElement(ComputerModePicker, {
          value: "team",
          onChange: vi.fn(),
          showConsequence: false,
        }),
      ),
    ),
  );
  for (const fact of [
    "This computer",
    "Runs as you; can use your files and signed-in tools",
    "Shared with team",
    "Bots share files and installed tools",
    "Stopped",
  ]) {
    expect(container.textContent?.split(fact).length).toBe(2);
  }
});

it.each(Object.entries(COMPUTER_STATES))(
  "renders the shared phrase for %s on phone",
  async (state, label) => {
    await act(async () =>
      root.render(
        createElement(RuntimeSummary, {
          status: { ...status, state: state as ComputerStatus["state"] },
        }),
      ),
    );
    expect(container.textContent).toContain(label);
  },
);

it.each([true, false])(
  "offers confirmed release on phone only when permitted: %s",
  async (canReleaseReservation) => {
    const update: ComputerUpdate = {
      id: "interrupted",
      botId: "other",
      computerId: "computer",
      name: "Builder",
      mode: "team",
      action: "update",
      stage: "saving",
      status: "interrupted",
      canReleaseReservation,
    };
    request.mockImplementation(async (procedure) =>
      procedure === "computer/status"
        ? { ...status, computerId: "computer", state: "suspending" }
        : procedure === "computer/updates"
          ? [update]
          : [],
    );
    await act(async () =>
      root.render(createElement(BotRuntimeSettings, { botId: "bot", mode: "dedicated" })),
    );
    expect(container.textContent).toContain("Paused for an update");
    expect(container.textContent).not.toContain("Starting");
    expect(container.textContent).toContain("The last update was interrupted.");
    const button = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent === "Release computer",
    );
    expect(Boolean(button)).toBe(canReleaseReservation);
    if (!button) return;
    await act(async () => button.click());
    expect(Alert.alert).toHaveBeenCalledWith(
      "Release interrupted computer?",
      "Make sure nothing is still running on this computer.",
      expect.any(Array),
    );
    expect(releaseInterrupted).not.toHaveBeenCalled();
    await act(async () => vi.mocked(Alert.alert).mock.calls[0]![2]![1]!.onPress!());
    expect(releaseInterrupted).toHaveBeenCalledExactlyOnceWith("interrupted");
  },
);

it("fails closed for an unknown kind", async () => {
  await act(async () =>
    root.render(
      createElement(RuntimeSummary, {
        status: { ...status, kind: "vm" as ComputerStatus["kind"] },
      }),
    ),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Choose a supported connection",
  );
});
async function enterName() {
  const input = container.querySelector<HTMLInputElement>('input[placeholder="Name this bot"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Builder",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const createButton = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Create",
  )!;
it("offers setup for new isolated work when no container is configured", async () => {
  request.mockImplementation(async (procedure) =>
    procedure === "me" ? { sandboxProvider: "desktop" } : [],
  );
  await act(async () => root.render(createElement(NewBot)));
  await enterName();
  expect(createButton().disabled).toBe(true);
  expect(container.textContent).toContain("Set up a container for isolated work.");
  expect(request.mock.calls.some((call) => call[0] === "bots/create")).toBe(false);
});
it("allows an explicit team choice only after showing the host and sharing warning", async () => {
  request.mockImplementation(async (procedure) =>
    procedure === "me"
      ? { sandboxProvider: "desktop" }
      : procedure === "bots/create"
        ? { id: "new-bot", name: "Builder" }
        : [],
  );
  await act(async () => root.render(createElement(NewBot)));
  await enterName();
  expect(createButton().disabled).toBe(true);
  const team = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Shared with team",
  )!;
  await act(async () => team.click());
  expect(container.textContent).toContain("Runs as you; can use your files and signed-in tools");
  expect(container.textContent).toContain("Bots share files and installed tools");
  await act(async () => createButton().click());
  const input = request.mock.calls.find((call) => call[0] === "bots/create")?.[1];
  expect(input).toMatchObject({ computerMode: "team" });
  expect(input).not.toHaveProperty("isolatedComputer");
});
it.each(["docker", "desktop"])(
  "uses the dedicated container recommendation on a %s deployment",
  async (provider) => {
    request.mockImplementation(async (procedure) =>
      procedure === "me"
        ? { sandboxProvider: provider }
        : procedure === "computer/connections"
          ? provider === "desktop"
            ? [{ id: "saved", name: "Container engine", settings: { engine: "podman" } }]
            : []
          : procedure === "bots/create"
            ? { id: "new-bot", name: "Builder" }
            : [],
    );
    await act(async () => root.render(createElement(NewBot)));
    await enterName();
    await act(async () => createButton().click());
    expect(request).toHaveBeenCalledWith(
      "bots/create",
      expect.objectContaining({
        computerMode: "dedicated",
        isolatedComputer: { connectionId: provider === "docker" ? null : "saved" },
      }),
    );
  },
);
