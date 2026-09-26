// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemBridge, SystemState } from "./bridge";

const fake = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  dispatch: vi.fn(async () => ({ enabled: true, canChange: true })),
  setDispatch: vi.fn(async ({ enabled }) => ({ enabled, canChange: true })),
}));
vi.mock("../../lib/rpc", () => ({
  selectedSpaceId: () => "space",
  rpc: {
    system: { dispatch: fake.dispatch, setDispatch: fake.setDispatch },
    computer: { list: fake.list },
  },
}));
const translate = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((text, part, i) => text + part + (values[i] ?? ""), "");
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: translate }) }));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: ComponentProps<"button"> & { checked: boolean; onCheckedChange(value: boolean): void }) => (
    <button
      {...props}
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

import { SystemPage } from "./SystemPage";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.list.mockClear();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  delete window.ardurbotDesktop;
  vi.unstubAllGlobals();
});
async function render(children: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(children));
  return container;
}
function fixture(platform = "darwin", mode: "new" | "existing" = "new") {
  const state: SystemState = {
    version: "0.1.0-alpha.1",
    platform,
    mode,
    preferences: {
      runOnStartup: false,
      quickAccess: "Off",
      voice: "Off",
      dictation: "Off",
      menuBar: false,
      keepAwake: false,
      openLinksInBrowser: false,
    },
    startupSupported: platform !== "linux",
    awakeRoutines: 0,
    storage: { path: "/fixture/storage", canMove: true, progress: null },
    permissions: { accessibility: "granted", screen: "not-determined" },
    shortcutError: false,
    shortcutOptions: {
      quickAccess: ["Off", "Alt+Space", "Control+Space"],
      voice: ["Off", "CommandOrControl+Shift+V"],
      dictation: ["Off", "CommandOrControl+D"],
    },
  };
  const bridge: SystemBridge = {
    state: vi.fn(async () => structuredClone(state)),
    set: vi.fn(async () => state),
    moveStorage: vi.fn(async () => state),
    openPermission: vi.fn(async () => undefined),
  };
  return { state, bridge };
}

describe("desktop system rows", () => {
  it("shows a restart hint in a browser or older desktop without the bridge", async () => {
    const c = await render(<SystemPage />);
    expect(c.textContent).toBe("Restart the desktop app to update it.");
    expect(fake.list).not.toHaveBeenCalled();
  });
  it("shows native macOS status with labeled controls and no unsupported rows", async () => {
    const f = fixture();
    const c = await render(<SystemPage bridge={f.bridge} />);
    expect(c.textContent).toContain("Desktop app version0.1.0-alpha.1");
    expect(c.textContent).toContain("Run on startup");
    expect(c.textContent).toContain("AccessibilityGranted");
    expect(c.textContent).toContain("Screen recordingNot requested");
    for (const omitted of [
      "Tap Option twice",
      "Caps Lock",
      "Denied apps",
      "Allowed sites",
      "Unhide apps",
      "Full control",
      "Chrome on this Mac",
    ])
      expect(c.textContent).not.toContain(omitted);
    expect(c.querySelector("label[for='system-voice']")).not.toBeNull();
    expect(c.querySelector("#system-voice")?.getAttribute("aria-describedby")).toBe(
      "system-voice-description",
    );
    await act(async () => (c.querySelector("#system-runOnStartup") as HTMLButtonElement).click());
    expect(f.bridge.set).toHaveBeenCalledWith("runOnStartup", true);
  });
  it.each(["win32", "linux"])("hides macOS rows on %s", async (platform) => {
    const f = fixture(platform);
    const c = await render(<SystemPage bridge={f.bridge} />);
    expect(c.textContent).not.toContain("Accessibility");
    expect(c.textContent).not.toContain("Screen recording");
    expect(c.textContent).not.toContain("Menu bar");
    expect(c.textContent?.includes("Run on startup")).toBe(platform === "win32");
  });
  it("hides folder buttons and paths for an existing instance even with a stale capability", async () => {
    const f = fixture("darwin", "existing");
    const c = await render(<SystemPage bridge={f.bridge} />);
    expect(c.textContent).toContain("This folder is managed by the server.");
    expect(c.textContent).not.toContain("/fixture/storage");
    expect(c.textContent).not.toContain("Use recommended");
    expect(
      [...c.querySelectorAll("button")].some((button) => button.textContent === "Change"),
    ).toBe(false);
  });
  it("shows no awake count until the native blocker is active", async () => {
    const f = fixture();
    const c = await render(<SystemPage bridge={f.bridge} />);
    expect(c.textContent).not.toContain("Awake for");
    f.state.awakeRoutines = 3;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(c.textContent).toContain("Awake for 3 routines");
  });
  it("refuses a shortcut conflict visibly without changing the selection", async () => {
    const f = fixture();
    vi.mocked(f.bridge.set).mockRejectedValueOnce(
      new Error("That shortcut is already in use; choose another."),
    );
    const c = await render(<SystemPage bridge={f.bridge} />);
    const select = c.querySelector<HTMLSelectElement>("#system-quickAccess")!;
    await act(async () => {
      select.value = "Alt+Space";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(c.querySelector("[role=alert]")?.textContent).toBe(
      "That shortcut is already in use; choose another.",
    );
    expect(select.value).toBe("Off");
  });
  it("sends native folder requests rather than accepting a typed renderer path", async () => {
    const f = fixture();
    const c = await render(<SystemPage bridge={f.bridge} />);
    for (const text of ["Change", "Use recommended"]) {
      await act(async () =>
        [...c.querySelectorAll("button")].find((b) => b.textContent === text)!.click(),
      );
    }
    expect(vi.mocked(f.bridge.moveStorage).mock.calls).toEqual([[false], [true]]);
  });
});

it("offers Reset local data only when this app keeps the data", async () => {
  const f = fixture();
  f.bridge.resetLocalData = vi.fn(async () => f.state);
  const resetButton = (c: HTMLElement) =>
    [...c.querySelectorAll("button")].find((b) => b.textContent === "Reset local data");
  const paired = await render(<SystemPage bridge={f.bridge} />);
  expect(resetButton(paired)).toBeUndefined();
  f.state.localData = true;
  const local = await render(<SystemPage bridge={f.bridge} />);
  expect(local.querySelector("label[for='system-local-data']")?.textContent).toBe("Local data");
  // The row's label names the row; the button keeps its action as its name.
  expect(resetButton(local)!.id).toBe("");
  await act(async () => resetButton(local)!.click());
  expect(f.bridge.resetLocalData).toHaveBeenCalledOnce();
});

it("hides local routine power controls when connected to an existing server", async () => {
  const f = fixture("darwin", "existing");
  const c = await render(<SystemPage bridge={f.bridge} />);
  expect(c.textContent).not.toContain("Keep computer awake");
  expect(c.textContent).toContain("This folder is managed by the server.");
});
