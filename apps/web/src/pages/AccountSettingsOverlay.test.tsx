// @vitest-environment jsdom

import { act } from "react";
import { expect, it, vi } from "vitest";
import { changeInput, renderSettings } from "../test/settings-ui";

const fake = vi.hoisted(() => ({ changePassword: vi.fn(), setUiLocale: vi.fn() }));
vi.mock("../lib/auth", () => ({ authClient: { changePassword: fake.changePassword } }));
vi.mock("../lib/i18n", () => ({ getActiveUiLocale: () => "en", setUiLocale: fake.setUiLocale }));

import { AccountLanguage } from "./account/AccountLanguage";
import { AccountSignIn } from "./account/AccountSignIn";

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
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  await act(async () => Promise.resolve());
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
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
