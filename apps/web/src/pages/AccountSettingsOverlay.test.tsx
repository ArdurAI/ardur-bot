// @vitest-environment jsdom

import { DEFAULT_USER_PREFERENCES } from "@ardurbot/contracts";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { changeInput, renderSettings, waitForSettings } from "../test/settings-ui";

const fake = vi.hoisted(() => ({ changePassword: vi.fn(), setUiLocale: vi.fn() }));
vi.mock("../lib/auth", () => ({ authClient: { changePassword: fake.changePassword } }));
vi.mock("../lib/i18n", () => ({ getActiveUiLocale: () => "en", setUiLocale: fake.setUiLocale }));
vi.mock("../lib/rpc", () => ({
  rpc: {
    preferences: {
      get: async () => DEFAULT_USER_PREFERENCES,
      update: async () => ({ preferences: DEFAULT_USER_PREFERENCES }),
    },
    notifications: { capabilities: async () => ({ dispatchPush: false }) },
    updater: { status: async () => ({ installKind: "source" }) },
  },
  selectedSpaceId: () => null,
}));

import { PreferencesProvider } from "../components/PreferencesProvider";
import { resetPreferences } from "../lib/preferences";
import { AccountLanguage } from "./account/AccountLanguage";
import { AccountSignIn } from "./account/AccountSignIn";
import { SettingsOverlay } from "./SettingsOverlay";

async function renderSettingsDialog() {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  resetPreferences();
  const result = await renderSettings(
    <PreferencesProvider userId="test">
      <SettingsOverlay
        name="Test account"
        avatarStyle="robot"
        onAvatarStyleChange={vi.fn()}
        memoryConfig={null}
        onMemoryConfigChange={vi.fn()}
        onClose={vi.fn()}
        isDeploymentOwner={false}
      />
    </PreferencesProvider>,
  );
  await act(() => vi.dynamicImportSettled());
  await waitForSettings(() => !!result.container.querySelector('[data-settings-row="Language"]'));
  return result.container;
}
function languageTrigger(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('[data-testid="ui-locale-select"]')!;
}
function press(key: string) {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

it("preserves the language picker and applies its selection", async () => {
  fake.setUiLocale.mockResolvedValue("ru");
  const { container } = await renderSettings(<AccountLanguage />);
  const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  expect(trigger).toBeTruthy();
  await act(async () => trigger.click());
  // The portalled listbox renders outside the settings container.
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options().length).toBeGreaterThan(0);
  const russian = options().find((option) => option.textContent === "Русский")!;
  expect(russian).toBeTruthy();
  await act(async () => russian.click());
  expect(fake.setUiLocale).toHaveBeenCalledWith("ru");
  expect(trigger.textContent).toContain("Русский");
});
it("opens the language picker over the portalled Select, dismisses it and restores focus", async () => {
  fake.setUiLocale.mockResolvedValue("en");
  const { container } = await renderSettings(<AccountLanguage />);
  const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  await act(async () => trigger.click());
  const listbox = document.querySelector('[role="listbox"]');
  expect(listbox).toBeTruthy();
  // Dismiss with Escape and confirm focus returns to the trigger.
  // After opening, Base UI focuses the selected option inside the portal,
  // which can land a tick later under parallel workers, so wait for it.
  await vi.waitFor(() => expect(document.activeElement).not.toBe(trigger));
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  // jsdom never fires the animationend that unmounts the exit-transition
  // clone, so assert the interactive state instead of portal node absence.
  await vi.waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
  expect(document.activeElement).toBe(trigger);
});
it("keyboard-drives the language picker inside the real settings dialog", async () => {
  fake.setUiLocale.mockResolvedValue("de");
  const container = await renderSettingsDialog();
  const trigger = languageTrigger(container);
  trigger.focus();
  expect(document.activeElement).toBe(trigger);
  // Open from the keyboard: Enter on the focused combobox is a virtual click.
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    trigger.click();
  });
  await vi.waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options().length).toBeGreaterThan(1);
  // Arrows move the highlight; focus lands on the highlighted option.
  await vi.waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("option"));
  for (let step = 0; step < 9; step++) {
    await act(async () => press("ArrowDown"));
    expect(document.activeElement?.getAttribute("role")).toBe("option");
    if (document.activeElement?.textContent === "Deutsch") break;
  }
  expect(document.activeElement?.textContent).toBe("Deutsch");
  // Enter commits the highlighted option through useButton's virtual click.
  await act(async () => press("Enter"));
  await vi.waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
  expect(fake.setUiLocale).toHaveBeenCalledWith("de");
  expect(trigger.textContent).toContain("Deutsch");
  // The persisted choice survives inside the still-open Settings dialog.
  await act(async () => trigger.click());
  await vi.waitFor(() =>
    expect(
      options().find((option) => option.getAttribute("aria-selected") === "true")?.textContent,
    ).toBe("Deutsch"),
  );
  expect(container.querySelector('[data-settings-section="general"]')).not.toBeNull();
});
it("Escape closes the picker but keeps the settings dialog open with focus on the trigger", async () => {
  fake.setUiLocale.mockReset();
  fake.setUiLocale.mockResolvedValue("en");
  const container = await renderSettingsDialog();
  const trigger = languageTrigger(container);
  trigger.focus();
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    trigger.click();
  });
  await vi.waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  await vi.waitFor(() => expect(document.activeElement).not.toBe(trigger));
  await act(async () => press("Escape"));
  await vi.waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
  expect(document.activeElement).toBe(trigger);
  expect(fake.setUiLocale).not.toHaveBeenCalled();
  // The Settings dialog itself is still open.
  expect(container.querySelector('[data-settings-section="general"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="user-settings"]')).not.toBeNull();
});

it("preserves password-manager fields, keeps the shell busy and refreshes sessions after a password change", async () => {
  let finish!: (result: { error: null }) => void;
  fake.changePassword.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const busy = vi.fn();
  const changed = vi.fn();
  const { container } = await renderSettings(
    <AccountSignIn email="owner@example.test" onBusyChange={busy} onChanged={changed} />,
  );
  expect(container.querySelector('input[name="username"]')?.getAttribute("autocomplete")).toBe(
    "username",
  );
  const inputs = container.querySelectorAll<HTMLInputElement>('input[type="password"]');
  await changeInput(inputs[0]!, "original-fixture-password");
  await changeInput(inputs[1]!, "changed-fixture-password");
  await changeInput(inputs[2]!, "changed-fixture-password");
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(busy).toHaveBeenLastCalledWith(true);
  expect(fake.changePassword).toHaveBeenCalledWith({
    currentPassword: "original-fixture-password",
    newPassword: "changed-fixture-password",
    revokeOtherSessions: true,
  });
  await act(async () => finish({ error: null }));
  expect(changed).toHaveBeenCalledOnce();
  expect(busy).toHaveBeenLastCalledWith(false);
  expect(inputs[0]!.value).toBe("");
});
