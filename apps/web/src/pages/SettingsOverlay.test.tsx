// @vitest-environment jsdom

import { DEFAULT_USER_PREFERENCES } from "@ardurbot/contracts";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { changeInput, renderSettings, waitForSettings } from "../test/settings-ui";

const fake = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), capabilities: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: {
    preferences: fake,
    capabilities: {
      settings: async () => ({
        settings: {
          toolAccessMode: "when-needed",
          connectorSearch: false,
          inlineVisualizations: true,
        },
        canConfigure: true,
        computers: [],
        unsupportedRuntimes: [],
      }),
    },
    host: { status: async () => ({ roots: ["folder"] }) },
    notifications: { capabilities: fake.capabilities },
  },
  selectedSpaceId: () => "space",
}));
vi.mock("./memory/MemoryPage", () => ({ MemoryPage: () => <div>Generate memory from chats</div> }));
vi.mock("./AccountSettingsOverlay", () => ({
  UsageSettingsPanel: () => <div>Usage content</div>,
  ComputerSettingsPanel: () => <div>This computer folders</div>,
  UpdatesSettingsPanel: () => <div>Update content</div>,
}));
vi.mock("./account/AccountSettings", () => ({ default: () => <div>Account content</div> }));
vi.mock("./MemorySettingsOverlay", () => ({
  MemorySettingsOverlay: () => <div>Existing memory and skills</div>,
}));
vi.mock("./ModelSettingsOverlay", () => ({ ModelSettingsOverlay: () => <div>Model content</div> }));
vi.mock("./ModelDestinations", () => ({ ModelDestinations: () => null }));
vi.mock("./VoiceSettingsOverlay", () => ({ VoiceSettingsOverlay: () => <div>Voice content</div> }));
vi.mock("./DevicesSettings", () => ({ DevicesSettings: () => <div>Device content</div> }));
vi.mock("./McpServersOverlay", () => ({ McpServersOverlay: () => <div>MCP servers</div> }));
vi.mock("./KnowledgeSection", () => ({ AgentSkills: () => <div>Existing skills</div> }));
vi.mock("./customize/ExtensionsPage", () => ({
  default: () => <div>Installed on your computer</div>,
}));
vi.mock("./customize/SkillsPage", () => ({ default: () => <div>Created by you</div> }));
vi.mock("./customize/PluginsPage", () => ({ default: () => <div>In this space</div> }));
vi.mock("./LearningInbox", () => ({
  LearningInbox: () => <div>Learning inbox timeline and curator</div>,
}));
vi.mock("../components/integrations/catalog/IntegrationCatalog", () => ({
  IntegrationCatalog: ({ reconnectId }: { reconnectId?: string }) => (
    <div data-reconnect-id={reconnectId}>Connected apps</div>
  ),
}));

import { PreferencesProvider } from "../components/PreferencesProvider";
import { resetPreferences } from "../lib/preferences";
import { SettingsOverlay } from "./SettingsOverlay";

const props = {
  name: "Test account",
  avatarStyle: "robot" as const,
  onAvatarStyleChange: vi.fn(),
  memoryConfig: null,
  onMemoryConfigChange: vi.fn(),
  onClose: vi.fn(),
};
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  resetPreferences();
  vi.clearAllMocks();
  fake.get.mockResolvedValue(DEFAULT_USER_PREFERENCES);
  fake.capabilities.mockResolvedValue({ dispatchPush: false });
  fake.update.mockImplementation(async (patch) => ({
    preferences: {
      ...DEFAULT_USER_PREFERENCES,
      ...patch,
      notifications: { ...DEFAULT_USER_PREFERENCES.notifications, ...patch.notifications },
    },
  }));
});
async function waitForSection(check: () => boolean) {
  await act(() => vi.dynamicImportSettled());
  await waitForSettings(check);
}
async function render(desktop = false) {
  if (desktop)
    window.ardurbotDesktop = { platform: "darwin" } as NonNullable<Window["ardurbotDesktop"]>;
  const result = await renderSettings(
    <PreferencesProvider userId="test">
      <SettingsOverlay {...props} isDeploymentOwner />
    </PreferencesProvider>,
  );
  await waitForSection(() => !!result.container.querySelector('[data-settings-row="Chat font"]'));
  return result.container;
}
it("filters sections and open row labels, then clears search on navigation", async () => {
  const container = await render();
  const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await changeInput(search, "chat font");
  expect(container.querySelector('[data-testid="settings-nav-general"]')).not.toBeNull();
  expect(container.querySelector<HTMLElement>('[data-settings-row="Theme"]')?.hidden).toBe(true);
  await changeInput(search, "privacy");
  expect(container.querySelectorAll('[data-testid^="settings-nav-"]')).toHaveLength(1);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="settings-nav-privacy"]')!.click(),
  );
  await waitForSection(() => container.textContent!.includes("Your data"));
  expect(search.value).toBe("");
  expect(container.textContent).not.toContain("How we protect your data");
});
it("saves theme, font and motion through RPC and applies their attributes", async () => {
  const container = await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="ui-appearance-light"]')!.click(),
  );
  expect(fake.update).toHaveBeenCalledWith({ theme: "light" });
  expect(document.documentElement.dataset.theme).toBe("light");
  for (const [label, value, attribute] of [
    ["Chat font", "serif", "chatFont"],
    ["Motion", "reduced", "motion"],
  ]) {
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    await act(async () => {
      select.value = value!;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.documentElement.dataset[attribute!]).toBe(value);
  }
});
it("hides notification switches with no delivery path", async () => {
  vi.stubGlobal("Notification", undefined);
  const container = await render();
  expect(container.querySelector('[aria-label="Response completions"]')).toBeNull();
  expect(container.querySelector('[aria-label="Dispatch messages"]')).toBeNull();
});
it("requests permission on a click and persists a notification change", async () => {
  const requestPermission = vi.fn(async () => "granted");
  vi.stubGlobal("Notification", { permission: "default", requestPermission });
  vi.stubGlobal("isSecureContext", true);
  const container = await render();
  expect(requestPermission).not.toHaveBeenCalled();
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Allow notifications")!
      .click(),
  );
  expect(requestPermission).toHaveBeenCalledOnce();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Routines"]')!.click(),
  );
  expect(fake.update).toHaveBeenCalledWith({ notifications: { routines: false } });
  expect(container.querySelector('[aria-label="Routines"]')?.getAttribute("aria-checked")).toBe(
    "false",
  );
});
it("keeps denied permission out of saved settings and retries a failed initial read", async () => {
  vi.stubGlobal("Notification", { permission: "denied" });
  vi.stubGlobal("isSecureContext", true);
  fake.get.mockRejectedValueOnce(new Error("offline"));
  const container = await render();
  expect(container.textContent).toContain("Could not load settings.");
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry")!
      .click(),
  );
  expect(
    container.querySelector('[data-testid="ui-appearance-light"]')?.hasAttribute("disabled"),
  ).toBe(false);
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Allow notifications")!
      .click(),
  );
  expect(container.textContent).toContain("Allow notifications in your browser settings");
  expect(fake.update).not.toHaveBeenCalled();
});
it("loads the registered pages without duplicate navigation", async () => {
  const container = await render(true);
  for (const [id, copy] of [
    ["account", "Account content"],
    ["capabilities", "Tool access mode"],
    ["memory", "Generate memory from chats"],
    ["system", "Restart the desktop app to update it."],
    ["extensions", "Installed on your computer"],
    ["developer", "Server URL"],
    ["skills", "Created by you"],
    ["integrations", "Connected apps"],
    ["mcp", "MCP servers"],
    ["learning", "Learning inbox timeline and curator"],
    ["plugins", "In this space"],
  ]) {
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`[data-testid="settings-nav-${id}"]`)!.click(),
    );
    await waitForSection(() => container.textContent!.includes(copy!));
  }
  expect(container.querySelector('[data-testid="settings-nav-local-api"]')).toBeNull();
});
it("opens the trusted registry from the integration deep link and preserves composer reconnection", async () => {
  const { container } = await renderSettings(
    <SettingsOverlay
      {...props}
      initialSection="integrations"
      initialIntegration="connection-test"
    />,
  );
  await waitForSection(() => container.textContent!.includes("Connected apps"));
  expect(container.querySelector('[data-settings-section="integrations"]')).not.toBeNull();
  expect(container.querySelector('[data-reconnect-id="connection-test"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="settings-nav-connectors"]')).toBeNull();
  expect(container.textContent).not.toContain("Search apps");
});

it("searches capability rows and opens Skills through the registry", async () => {
  const container = await render();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="settings-nav-capabilities"]')!
      .click(),
  );
  await waitForSettings(() => !!container.querySelector('[data-settings-row="Tool access mode"]'));
  const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await changeInput(search, "connector search");
  expect(container.querySelector('[data-testid="settings-nav-capabilities"]')).not.toBeNull();
  expect(
    container.querySelector<HTMLElement>('[data-settings-row="Tool access mode"]')!.hidden,
  ).toBe(true);
  expect(
    container.querySelector<HTMLElement>('[data-settings-row="Connector search"]')!.hidden,
  ).toBe(false);
  await changeInput(search, "");
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Skills have moved to Customize")!
      .click(),
  );
  await waitForSettings(() => container.textContent!.includes("Created by you"));
  expect(container.querySelector('[data-settings-section="skills"]')).not.toBeNull();
});

it("keeps storage and provider settings reachable from Memory without another dialog", async () => {
  const container = await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="settings-nav-memory"]')!.click(),
  );
  await waitForSettings(() => !!container.querySelector('[data-settings-row="Memory storage"]'));
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-settings-row="Memory storage"] button')!
      .click(),
  );
  await waitForSettings(() => container.textContent!.includes("Existing memory and skills"));
  expect(container.querySelector('[data-settings-section="memory"]')).not.toBeNull();
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Back to memory")!
      .click(),
  );
  await waitForSettings(() => container.textContent!.includes("Generate memory from chats"));
});
