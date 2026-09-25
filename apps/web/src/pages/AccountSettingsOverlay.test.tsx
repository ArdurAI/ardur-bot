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
  await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((button) => button.textContent === "Русский")!
      .click(),
  );
  expect(fake.setUiLocale).toHaveBeenCalledWith("ru");
  expect(container.querySelector('[role="combobox"]')?.textContent).toContain("Русский");
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
