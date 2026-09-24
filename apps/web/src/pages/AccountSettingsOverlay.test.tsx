// @vitest-environment jsdom

import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { renderSettings } from "../test/settings-ui";

vi.mock("../components/ApprovalRulesSettings", () => ({ ApprovalRulesSettings: () => null }));
vi.mock("../components/DesktopUpdates", () => ({ DesktopUpdateSection: () => null }));
vi.mock("../components/SoftwareUpdateSection", () => ({ SoftwareUpdateSection: () => null }));
vi.mock("./ComputerProfilesSettings", () => ({ ComputerProfilesSettings: () => null }));
vi.mock("./HostComputerSettings", () => ({ HostComputerSettings: () => null }));
vi.mock("../lib/auth", () => ({ authClient: { changePassword: vi.fn() } }));
vi.mock("../lib/i18n", () => ({ getActiveUiLocale: () => "en", setUiLocale: vi.fn() }));

import { GeneralSettingsPanels } from "./AccountSettingsOverlay";

it("keeps account, language, password and avatar controls reachable without a second theme control", async () => {
  const change = vi.fn();
  const { container } = await renderSettings(
    <MemoryRouter>
      <GeneralSettingsPanels
        name="Test account"
        email="owner@example.test"
        avatarStyle="robot"
        onAvatarStyleChange={change}
      />
    </MemoryRouter>,
  );
  expect(container.textContent).toContain("Test account");
  expect(container.textContent).toContain("Password");
  expect(container.querySelector('[aria-label="Language"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="ui-appearance-select"]')).toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="avatar-style-organic"]')!.click(),
  );
  expect(change).toHaveBeenCalledWith("organic");
});
