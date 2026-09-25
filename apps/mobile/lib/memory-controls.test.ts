// @vitest-environment jsdom
import { SpaceLearningConfigSchema } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
const copy = vi.hoisted(() => vi.fn(async () => undefined));
const focus = vi.hoisted(() => ({
  enter: undefined as (() => void) | undefined,
  leave: undefined as (() => void) | undefined,
}));
vi.mock("./api", () => ({ rpc: request }));
vi.mock("expo-clipboard", () => ({ setStringAsync: copy }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (fn: () => unknown) => fn() }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) =>
    useEffect(() => {
      focus.enter = () => {
        focus.leave = effect();
      };
      focus.enter();
      return () => {
        focus.leave?.();
      };
    }, [effect]),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", {}, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", {}, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Button: ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", onClick: onPress, disabled }, title),
  Switch: ({
    value,
    onValueChange,
    disabled,
    accessibilityLabel,
  }: {
    value: boolean;
    onValueChange: (value: boolean) => void;
    disabled: boolean;
    accessibilityLabel: string;
  }) =>
    createElement("button", {
      type: "button",
      role: "switch",
      "aria-label": accessibilityLabel,
      "aria-checked": value,
      onClick: () => onValueChange(!value),
      disabled,
    }),
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
    editable,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    accessibilityLabel: string;
    editable?: boolean;
  }) =>
    createElement("textarea", {
      value,
      "aria-label": accessibilityLabel,
      disabled: editable === false,
      onChange: (event: { currentTarget: HTMLTextAreaElement }) =>
        onChangeText(event.currentTarget.value),
    }),
}));

import { MemoryControls, MemoryIntentControls } from "./MemoryControls";

async function mounted(element: ReactNode, work: (container: HTMLDivElement) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(element));
    await work(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}
function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
function input(container: HTMLElement, label: string, text: string) {
  const textarea = container.querySelector(`textarea[aria-label="${label}"]`);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
    textarea,
    text,
  );
  textarea!.dispatchEvent(new Event("input", { bubbles: true }));
}
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function pendingRequest() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it.each([
  ["This bot may only run locally — change the pin or the space policy", true],
  [
    "Memory review is not available with Claude Code or Codex yet; import memory or edit a document directly.",
    true,
  ],
  ["private provider failure", false],
])("shows only a recognized native review refusal: %s", async (message, recognized) => {
  request.mockRejectedValue(new Error(message as string));
  await mounted(createElement(MemoryIntentControls), async (container) => {
    await act(async () =>
      input(container, "Tell your bot what to change or remove", "Use short answers."),
    );
    await act(async () => button(container, "Send").click());
    expect(container.textContent).toContain(
      recognized ? message : "Could not prepare memory changes. Try again.",
    );
    if (!recognized) expect(container.textContent).not.toContain(message);
    expect(button(container, "Send").disabled).toBe(false);
  });
});

it.each(["import", "edit"] as const)(
  "unlocks a pending %s after blur without showing stale proposals",
  async (intent) => {
    const pending = pendingRequest();
    request.mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    await mounted(createElement(MemoryIntentControls), async (container) => {
      if (intent === "import") await act(async () => button(container, "Start import").click());
      const label = intent === "import" ? "Paste memory" : "Tell your bot what to change or remove";
      const submit = intent === "import" ? "Review import" : "Send";
      await act(async () => input(container, label, "Use short answers."));
      await act(async () => button(container, submit).click());
      expect(button(container, submit).disabled).toBe(true);
      await act(async () => focus.leave?.());
      await act(async () => pending.resolve([]));
      await act(async () => focus.enter?.());
      expect(button(container, submit).disabled).toBe(false);
      const field = container.querySelector(
        `textarea[aria-label="${label}"]`,
      ) as HTMLTextAreaElement;
      expect(field.disabled).toBe(false);
      expect(field.value).toBe("Use short answers.");
      expect(container.textContent).not.toContain("Pending approval");
      await act(async () => button(container, submit).click());
      expect(request).toHaveBeenCalledTimes(2);
    });
  },
);

it("unlocks an edit that fails after refocus without showing a stale error", async () => {
  const pending = pendingRequest();
  request.mockReturnValueOnce(pending.promise);
  await mounted(createElement(MemoryIntentControls), async (container) => {
    await act(async () =>
      input(container, "Tell your bot what to change or remove", "Use short answers."),
    );
    await act(async () => button(container, "Send").click());
    await act(async () => focus.leave?.());
    await act(async () => focus.enter?.());
    expect(button(container, "Send").disabled).toBe(true);
    await act(async () => pending.reject(new Error("offline")));
    expect(button(container, "Send").disabled).toBe(false);
    expect(container.textContent).not.toContain("Could not prepare memory changes.");
  });
});

it.each([false, true])("unlocks generation after focus changes and failure=%s", async (failed) => {
  const settings = SpaceLearningConfigSchema.parse({
    enabled: true,
    canConfigure: true,
    destination: null,
  });
  const pending = pendingRequest();
  request.mockImplementation((path: string) =>
    path === "learning/configure" ? pending.promise : Promise.resolve(settings),
  );
  await mounted(createElement(MemoryControls), async (container) => {
    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(toggle.disabled).toBe(true);
    await act(async () => focus.leave?.());
    await act(async () => focus.enter?.());
    await act(async () =>
      failed
        ? pending.reject(new Error("offline"))
        : pending.resolve({ ...settings, enabled: false }),
    );
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).not.toContain("Could not save memory settings.");
  });
});

it("uses the native switch to change generation consent without granting automatic approval", async () => {
  const settings = SpaceLearningConfigSchema.parse({
    enabled: true,
    canConfigure: true,
    destination: null,
  });
  request.mockImplementation(async (path: string) =>
    path === "learning/configure" ? { ...settings, enabled: false } : settings,
  );
  await mounted(createElement(MemoryControls), async (container) => {
    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "learning/settings",
      "learning/configure",
    ]);
  });
});

it("copies the import prompt and renders pending import and composer proposals with no direct writes", async () => {
  request.mockResolvedValue([
    {
      id: "proposal",
      type: "memory",
      scope: { spaceId: "space", userId: "user" },
      target: {},
      proposedContent: "Use concise answers.",
      rationale: "Requested change",
      evidenceIds: ["evidence"],
      diff: "+Use concise answers.",
      status: "pending",
      expiresAt: "2099-01-01T00:00:00Z",
    },
  ]);
  await mounted(createElement(MemoryIntentControls), async (container) => {
    await act(async () => button(container, "Start import").click());
    await act(async () => button(container, "Copy prompt").click());
    expect(copy).toHaveBeenCalledWith(expect.stringContaining("plain bullet points"));
    await act(async () => input(container, "Paste memory", "Preferences\n- Use concise answers."));
    await act(async () => button(container, "Review import").click());
    expect(container.textContent).toContain("Pending approval");
    await act(async () =>
      input(container, "Tell your bot what to change or remove", "Remove my old preference."),
    );
    await act(async () => button(container, "Send").click());
    expect(request.mock.calls.map(([path]) => path)).toEqual(["memory/propose", "memory/propose"]);
    expect(request.mock.calls.map(([, body]) => body.intent)).toEqual(["import", "edit"]);
    expect(container.textContent).toContain("Review proposals");
  });
});
