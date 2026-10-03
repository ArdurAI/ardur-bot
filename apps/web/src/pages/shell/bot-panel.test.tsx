import { modelPinOptionKey, parseModelPinOptionKey } from "@ardurbot/core";
import { i18n } from "@lingui/core";

// @vitest-environment jsdom

import type {
  Bot,
  ComputerStatus,
  ModelCatalogEntry,
  ModelCredential,
  RuntimeAvailability,
} from "@ardurbot/contracts";
import { failureCategoryMessage, HERMES_CONTEXT_LIMIT_MESSAGE } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { rpc } from "../../lib/rpc";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  validatePin: vi.fn(),
  credentials: vi.fn(),
  me: vi.fn(),
  availability: vi.fn(),
  connections: vi.fn(),
  computers: vi.fn(),
  status: vi.fn(),
  creationOptions: vi.fn(
    async (): Promise<Awaited<ReturnType<typeof rpc.computer.creationOptions>>> => ({
      defaultLocation: "sandbox",
      hostAvailable: false,
      container: { connectionId: null },
      sandboxAvailable: true,
      team: null,
    }),
  ),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    delegations: { policy: async () => ({ mode: "any" }), setPolicy: async () => ({ ok: true }) },
    models: api,
    runtimes: { availability: api.availability },
    me: api.me,
    host: { status: async () => ({ connected: true }) },
    computer: {
      connections: api.connections,
      list: api.computers,
      status: api.status,
      updates: async () => [],
      creationOptions: api.creationOptions,
    },
    voice: { voices: async () => [] },
  },
}));
vi.mock("./avatar-studio-popover", () => ({ AvatarStudioPopover: () => null }));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => null }));
vi.mock("../KnowledgeSection", () => ({ KnowledgeSection: () => null }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Toggle: ({
    children,
    pressed,
    onPressedChange,
    "data-testid": testId,
  }: {
    children: ReactNode;
    pressed: boolean;
    onPressedChange: (value: boolean) => void;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      aria-pressed={pressed}
      data-testid={testId}
      onClick={() => onPressedChange(!pressed)}
    >
      {children}
    </button>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<ComponentProps<"input">, "onChange"> & { onCheckedChange: (value: boolean) => void }) => (
    <input
      {...props}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));

import { useModelSettings } from "../../lib/use-model-settings";
import { BotModelChip, effectiveBotModel } from "./bot-model-chip";
import { BotSettings, CreateBotForm } from "./bot-panel";
import { ProviderErrorMessage } from "./provider-error-message";
import { RuntimeSettings } from "./runtime-settings";

const bot: Bot = {
  runtimeKind: "pi",
  id: "bot-test",
  spaceId: "space-test",
  name: "Test bot",
  title: "",
  description: "",
  instructions: "",
  color: "slate",
  notifyOnFinish: true,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: "thread-test",
  preview: "",
  status: "idle",
  computerMode: "team",
  updatedAt: "2026-09-23",
  createdAt: "2026-09-23",
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  webhookConfigured: false,
  spawnKey: null,
};
const catalog: ModelCatalogEntry[] = [
  "gpt-5.3-codex-spark",
  "gpt-5.5",
  "gpt-6-sol",
  "gpt-6-astra",
].map((id) => ({
  id,
  provider: "openai-codex",
  providerName: "OpenAI Codex",
  billing: "",
  auth: "oauth",
  label: id === "gpt-6-astra" ? "GPT-6 Astra" : id,
  reasoning: true,
  thinkingLevels: ["low", "medium", "high", "xhigh"],
}));
const credentials: ModelCredential[] = [
  {
    id: "credential-test",
    provider: "openai-codex",
    label: "Codex",
    hasKey: true,
    isDefault: true,
    modelId: "gpt-5.3-codex-spark",
  },
];
const me = { defaultProvider: "openai-codex", defaultModel: "gpt-6-astra" };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.list.mockResolvedValue(catalog);
  api.validatePin.mockResolvedValue({ ok: true });
  api.credentials.mockResolvedValue(credentials);
  api.me.mockResolvedValue(me);
  api.connections.mockResolvedValue([]);
  api.computers.mockResolvedValue([]);
  api.status.mockResolvedValue({
    botId: bot.id,
    kind: "desktop",
    mode: "team",
    state: "stopped",
  } as ComputerStatus);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const onSave = vi.fn(async (): Promise<{ modelPinRevision?: number } | undefined> => undefined);
function settings(
  overrides: Partial<Bot> = {},
  modelFocusRequest = 0,
  overrideGroups: Parameters<typeof BotSettings>[0]["overrideGroups"] = [],
  onOpenGroup?: (groupId: string) => void,
) {
  return (
    <BotSettings
      bot={{ ...bot, ...overrides }}
      modelFocusRequest={modelFocusRequest}
      memoryProviderConfigured={false}
      onSkillsChange={() => undefined}
      onSave={onSave}
      onExport={async () => undefined}
      onClear={() => undefined}
      overrideGroups={overrideGroups}
      onOpenGroup={onOpenGroup}
    />
  );
}
function modelSelect() {
  const select = container.querySelector<HTMLSelectElement>('select[id$="-model"]');
  if (!select) throw new Error("Missing model select");
  return select;
}
async function save() {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === "Save",
  );
  if (!button) throw new Error("Missing Save button");
  await act(async () => button.click());
}

describe("bot model settings", () => {
  it("pluralizes group choices and links to each group", async () => {
    const onOpenGroup = vi.fn();
    const group = {
      id: "group",
      name: "Review room",
      members: [{ botId: bot.id, runtimePin: { runtimeKind: "pi" } }],
    } as never;
    await act(async () =>
      root.render(settings({ groupModelOverrideCount: 1 }, 0, [group], onOpenGroup)),
    );
    expect(container.textContent).toContain("Also set differently in 1 group");
    await act(async () =>
      root.render(settings({ groupModelOverrideCount: 2 }, 0, [group], onOpenGroup)),
    );
    expect(container.textContent).toContain("Also set differently in 2 groups");
    const link = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review room",
    );
    await act(async () => link?.click());
    expect(onOpenGroup).toHaveBeenCalledWith("group");
  });

  it.each([0, 2])(
    "asks for a connection with %i available and never preselects one",
    async (count) => {
      api.credentials.mockResolvedValue(
        count
          ? [
              { ...credentials[0], id: "first", label: "First connection" },
              { ...credentials[0], id: "second", label: "Second connection" },
            ]
          : [],
      );
      await act(async () =>
        root.render(
          settings({
            modelProvider: "openai-codex",
            modelId: "gpt-6-sol",
            modelCredentialId: null,
            modelPinRevision: 0,
            thinkingLevel: null,
          }),
        ),
      );
      const select = modelSelect();
      expect(select.value).toBe("openai-codex::gpt-6-sol");
      expect(select.selectedOptions[0]?.textContent).toBe(
        "openai-codex · gpt-6-sol (not available on your account)",
      );
      expect(select.selectedOptions[0]?.className).toContain("text-muted-foreground");
      const prompt = [...container.querySelectorAll("p")].find(
        (item) =>
          item.textContent ===
          "This bot's connection needs to be chosen. Pick the connection to use.",
      );
      expect(prompt).toBeDefined();
      expect(prompt?.nextElementSibling?.textContent).toContain("Save");
      expect(onSave).not.toHaveBeenCalled();
      await save();
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: "openai-codex",
          modelId: "gpt-6-sol",
          modelCredentialId: null,
          thinkingLevel: null,
        }),
      );
      if (count) {
        expect(select.textContent).toContain("First connection · gpt-6-sol");
        expect(select.textContent).toContain("Second connection · gpt-6-sol");
        await act(async () => {
          select.value = modelPinOptionKey("openai-codex", "gpt-6-sol", "second");
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(container.textContent).not.toContain("This bot's connection needs to be chosen.");
        await save();
        expect(onSave).toHaveBeenLastCalledWith(
          expect.objectContaining({ modelCredentialId: "second" }),
        );
      }
    },
  );

  it("does not ask to choose a connection for an already bound pin", async () => {
    await act(async () =>
      root.render(
        settings({
          modelProvider: "openai-codex",
          modelId: "gpt-6-sol",
          modelCredentialId: "credential-test",
          modelPinRevision: 1,
          thinkingLevel: "high",
        }),
      ),
    );
    expect(container.textContent).not.toContain("This bot's connection needs to be chosen.");
  });
  it("does not reintroduce a stored Spark credential as a free-form option", async () => {
    await act(async () => root.render(settings()));
    expect([...modelSelect().options].map((option) => option.value)).toEqual([
      "",
      modelPinOptionKey("openai-codex", "gpt-6-astra", "credential-test"),
      modelPinOptionKey("openai-codex", "gpt-6-sol", "credential-test"),
      modelPinOptionKey("openai-codex", "gpt-5.5", "credential-test"),
    ]);
    expect(modelSelect().value).toBe("");
    await save();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ modelProvider: null, modelId: null }),
    );
  });

  it.each([false, true])(
    "keeps an unavailable %s override or inherited default visible and never rewrites it on save",
    async (override) => {
      api.me.mockResolvedValue({ ...me, defaultModel: "gpt-5.3-codex-spark" });
      await act(async () =>
        root.render(
          settings(
            override ? { modelProvider: "openai-codex", modelId: "gpt-5.3-codex-spark" } : {},
          ),
        ),
      );
      expect(modelSelect().value).toBe(override ? "openai-codex::gpt-5.3-codex-spark" : "");
      const selected = modelSelect().options[modelSelect().selectedIndex];
      expect(selected?.textContent).toContain("not available on your account");
      expect(container.textContent).toContain(
        override
          ? "This bot's connection needs to be chosen. Pick the connection to use."
          : "This model is not available on your account. Choose another model.",
      );
      expect(onSave).not.toHaveBeenCalled();
      await save();
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining(
          override
            ? { modelProvider: "openai-codex", modelId: "gpt-5.3-codex-spark" }
            : { modelProvider: null, modelId: null },
        ),
      );
    },
  );

  it("preserves a supported override", async () => {
    await act(async () =>
      root.render(
        settings({ modelProvider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "xhigh" }),
      ),
    );
    expect(modelSelect().value).toBe("openai-codex::gpt-6-sol");
    await save();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "gpt-6-sol", thinkingLevel: "xhigh" }),
    );
  });

  it("preserves custom connections outside the catalog", async () => {
    api.credentials.mockResolvedValue([
      { ...credentials[0], provider: "openai-compatible", modelId: "custom-model" },
    ]);
    await act(async () =>
      root.render(settings({ modelProvider: "openai-compatible", modelId: "custom-model" })),
    );
    expect(modelSelect().value).toBe("openai-compatible::custom-model");
    expect(modelSelect().textContent).toContain("custom-model");
  });

  it("focuses Model above collapsed Advanced on each request", async () => {
    await act(async () => root.render(settings({}, 1)));
    expect(container.querySelector("details")?.open).toBe(false);
    expect(modelSelect().closest("details")).toBeNull();
    expect(document.activeElement).toBe(modelSelect());
    await act(async () => root.render(settings({}, 2)));
    expect(document.activeElement).toBe(modelSelect());
  });
});

it("shows execution settings outside Advanced while keeping memory progressive", async () => {
  await act(async () => root.render(settings()));
  const cards = [...container.querySelectorAll("section[data-settings-group]")];
  const title = (card: Element) => card.querySelector("h3")?.textContent;
  expect(cards.map(title)).toEqual([
    "Profile",
    "Model",
    "Where this bot runs",
    "Notifications",
    "Memory",
  ]);
  const card = (label: string) => cards.find((item) => title(item) === label)!;
  const profileFields = card("Profile").querySelector('input[id$="-name"]')?.closest(".grid");
  const defaultPaneWidth = 560;
  const border = 1;
  const padding = 40; // px-5 padding on scroll container
  const classicScrollbar = 16;
  const defaultContainerWidth = defaultPaneWidth - border - padding - classicScrollbar; // ~503 px
  const minContainerWidth = 384 - border - padding; // ~343 px
  const breakpointMatch = profileFields?.className.match(/@min-\[(\d+)px\]:grid-cols-2/);
  expect(breakpointMatch).not.toBeNull();
  const breakpoint = Number(breakpointMatch![1]);
  expect(breakpoint).toBeLessThanOrEqual(defaultContainerWidth);
  expect(breakpoint).toBeGreaterThan(minContainerWidth);
  expect(container.querySelector('[data-testid="bot-settings"]')?.className).toContain(
    "@container",
  );
  expect(card("Model").contains(modelSelect())).toBe(true);
  expect(card("Notifications").textContent).toContain(
    "Get notified when this Bot finishes or needs input",
  );
  expect(card("Notifications").textContent).toContain("Read replies aloud");
  const advanced = container.querySelector('[data-testid="bot-settings-advanced"]');
  expect(advanced?.contains(card("Memory"))).toBe(true);
  expect(advanced?.contains(card("Where this bot runs"))).toBe(false);
  expect(advanced?.contains(card("Notifications"))).toBe(false);
  for (const fact of ["Shared with team", "Bots share files and installed tools"]) {
    expect(card("Where this bot runs").textContent?.split(fact).length).toBe(2);
  }
});

describe("new isolated work", () => {
  async function enterName() {
    const input = container.querySelector<HTMLInputElement>('input[id$="-name"]')!;
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
  it("defaults to a dedicated container and submits an explicit pin", async () => {
    api.creationOptions.mockResolvedValue({
      defaultLocation: "sandbox",
      hostAvailable: false,
      container: { connectionId: null },
      sandboxAvailable: true,
      team: null,
    });
    const onCreate = vi.fn();
    await act(async () => root.render(<CreateBotForm onCreate={onCreate} onCancel={() => {}} />));
    expect(
      container.querySelector('[data-testid="create-bot-private"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.textContent).toContain("Sandbox");
    await enterName();
    await act(async () => createButton().click());
    expect(onCreate).toHaveBeenCalledWith({
      name: "Builder",
      title: "",
      description: "",
      computerMode: "dedicated",
      computerLocation: "sandbox",
      isolatedComputer: { connectionId: null },
    });
  });
  it.each(["team", "dedicated"] as const)(
    "creates on a non-container deployment sandbox with %s sharing",
    async (mode) => {
      api.creationOptions.mockResolvedValue({
        defaultLocation: "sandbox",
        hostAvailable: false,
        sandboxAvailable: true,
        container: null,
        team: { location: "sandbox", connectionId: null },
      });
      const onCreate = vi.fn();
      await act(async () => root.render(<CreateBotForm onCreate={onCreate} onCancel={() => {}} />));
      if (mode === "team")
        await act(async () =>
          container.querySelector<HTMLButtonElement>('[data-testid="create-bot-team"]')!.click(),
        );
      await enterName();
      expect(createButton().disabled).toBe(false);
      expect(container.textContent).not.toContain("Set up a container for isolated work.");
      await act(async () => createButton().click());
      expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
        computerMode: mode,
        computerLocation: "sandbox",
      });
      expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("isolatedComputer");
    },
  );
  it.each(["hosted", "test"] as const)(
    "the create form forwards the %s deployment boundary",
    async (sandboxBoundary) => {
      api.creationOptions.mockResolvedValue({
        defaultLocation: "sandbox",
        hostAvailable: false,
        sandboxAvailable: true,
        sandboxBoundary,
        container: null,
        team: null,
      });
      await act(async () => root.render(<CreateBotForm onCreate={vi.fn()} onCancel={() => {}} />));
      const sandbox = container.querySelector('[aria-label="Sandbox"]')!;
      expect(sandbox.textContent).toContain(
        sandboxBoundary === "hosted"
          ? "Runs at the configured provider; can use granted credentials and network access."
          : "For testing only; not an isolation boundary.",
      );
      expect(sandbox.textContent).not.toContain("Separate home;");
    },
  );
  it("offers setup rather than silently creating on the host", async () => {
    api.creationOptions.mockResolvedValue({
      defaultLocation: "sandbox",
      hostAvailable: false,
      container: null,
      sandboxAvailable: false,
      team: null,
    });
    const onCreate = vi.fn();
    const onSetupComputer = vi.fn();
    await act(async () =>
      root.render(
        <CreateBotForm onCreate={onCreate} onCancel={() => {}} onSetupComputer={onSetupComputer} />,
      ),
    );
    await enterName();
    expect(createButton().disabled).toBe(true);
    expect(container.textContent?.split("Set up a container for isolated work.")).toHaveLength(2);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="create-bot-team"]')!.click(),
    );
    // Sharing does not make an unavailable execution location usable.
    expect(createButton().disabled).toBe(true);
    const setup = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Set up computer",
    )!;
    await act(async () => setup.click());
    expect(onSetupComputer).toHaveBeenCalledOnce();
    expect(onCreate).not.toHaveBeenCalled();
  });
  it("allows an explicit team choice with the host warning and no isolated claim", async () => {
    api.creationOptions.mockResolvedValue({
      defaultLocation: "host",
      hostAvailable: true,
      container: { connectionId: null },
      sandboxAvailable: true,
      team: null,
    });
    const onCreate = vi.fn();
    await act(async () => root.render(<CreateBotForm onCreate={onCreate} onCancel={() => {}} />));
    await enterName();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="create-bot-team"]')!.click(),
    );
    expect(container.textContent).toContain("Runs as you; can use your files and signed-in tools");
    expect(container.textContent).toContain("Bots share files and installed tools");
    await act(async () => createButton().click());
    expect(onCreate).toHaveBeenCalledWith({
      name: "Builder",
      title: "",
      description: "",
      computerMode: "team",
      computerLocation: "host",
    });
  });
  it("uses a saved container on a host-only deployment", async () => {
    api.creationOptions.mockResolvedValue({
      defaultLocation: "sandbox",
      hostAvailable: false,
      container: { connectionId: "saved" },
      sandboxAvailable: true,
      team: null,
    });
    api.me.mockResolvedValue({ ...me, sandboxProvider: "desktop" });
    api.connections.mockResolvedValue([
      { id: "saved", name: "Container engine", settings: { engine: "podman" } },
    ]);
    const onCreate = vi.fn();
    await act(async () => root.render(<CreateBotForm onCreate={onCreate} onCancel={() => {}} />));
    await enterName();
    await act(async () => createButton().click());
    expect(onCreate.mock.calls[0]?.[0].isolatedComputer).toEqual({ connectionId: "saved" });
  });
  it.each(["host", "sandbox"] as const)(
    "follows the Team %s before submit and frees dedicated choices",
    async (location) => {
      api.creationOptions.mockResolvedValue({
        defaultLocation: location === "host" ? "sandbox" : "host",
        hostAvailable: true,
        container: { connectionId: null },
        sandboxAvailable: true,
        team: { location, connectionId: location === "sandbox" ? "saved" : null },
      });
      const onCreate = vi.fn();
      await act(async () => root.render(<CreateBotForm onCreate={onCreate} onCancel={() => {}} />));
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[data-testid="create-bot-team"]')!.click(),
      );
      const selected = location === "host" ? "This computer" : "Sandbox";
      const other = location === "host" ? "Sandbox" : "This computer";
      expect(
        container.querySelector(`[aria-label="${selected}"]`)?.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(container.querySelector<HTMLButtonElement>(`[aria-label="${other}"]`)?.disabled).toBe(
        true,
      );
      expect(
        container.querySelector(`[aria-label="${other}"]`)?.parentElement?.textContent,
      ).toContain("Choose Only this bot to use a different location from the Team computer.");
      await enterName();
      expect(createButton().disabled).toBe(false);
      await act(async () => createButton().click());
      expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
        computerMode: "team",
        computerLocation: location,
      });
      if (location === "sandbox")
        expect(onCreate.mock.calls[0]?.[0].isolatedComputer).toEqual({ connectionId: "saved" });
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[data-testid="create-bot-private"]')!.click(),
      );
      expect(container.querySelector<HTMLButtonElement>(`[aria-label="${other}"]`)?.disabled).toBe(
        false,
      );
    },
  );
  it("keeps the server-selected location independent from sharing", async () => {
    api.creationOptions.mockResolvedValue({
      defaultLocation: "sandbox",
      hostAvailable: false,
      container: { connectionId: null },
      sandboxAvailable: true,
      team: null,
    });
    api.connections.mockResolvedValue([
      { id: "saved", name: "Team engine", settings: { engine: "docker" } },
    ]);
    api.computers.mockResolvedValue([
      { status: { kind: "desktop", connectionId: "saved", mode: "team" } },
    ]);
    const onCreate = vi.fn();
    await act(async () => root.render(<CreateBotForm onCreate={onCreate} onCancel={() => {}} />));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="create-bot-team"]')!.click(),
    );
    expect(container.querySelector('[aria-label="Sandbox"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="This computer"]')?.disabled,
    ).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("effective bot model", () => {
  const state = { me, catalog, credentials };
  it("shows the catalog label and default reasoning effort", () => {
    expect(effectiveBotModel(bot, state)).toEqual({
      label: "GPT-6 Astra",
      providerLabel: "Codex",
      unavailable: false,
      thinkingLevel: "medium",
      isDefault: true,
    });
  });
  it("keeps the bot thinking override when inheriting the space model", () => {
    expect(effectiveBotModel({ ...bot, thinkingLevel: "xhigh" }, state)?.thinkingLevel).toBe(
      "xhigh",
    );
  });
  it("uses the connected bot override without a default suffix", () => {
    expect(
      effectiveBotModel(
        { ...bot, modelProvider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "xhigh" },
        state,
      ),
    ).toEqual({
      label: "gpt-6-sol",
      providerLabel: "Codex",
      unavailable: false,
      thinkingLevel: "xhigh",
      isDefault: false,
    });
  });
  it("keeps a disconnected pin visible with a warning", () => {
    expect(
      effectiveBotModel(
        { ...bot, modelProvider: "disconnected", modelId: "missing", thinkingLevel: "xhigh" },
        state,
      ),
    ).toEqual({
      label: "missing",
      providerLabel: "disconnected",
      thinkingLevel: "xhigh",
      isDefault: false,
      unavailable: true,
    });
  });
  it("uses custom connection labels and configured thinking", () => {
    expect(
      effectiveBotModel(bot, {
        me: { defaultProvider: "openai-compatible", defaultModel: "custom-model" },
        catalog: [],
        credentials: [
          {
            ...credentials[0]!,
            provider: "openai-compatible",
            modelId: "custom-model",
            reasoning: true,
            thinkingLevels: ["low", "medium", "high"],
            thinkingLevel: "low",
          },
        ],
      }),
    ).toEqual({
      label: "custom-model",
      providerLabel: "openai-compatible",
      unavailable: false,
      thinkingLevel: "low",
      isDefault: true,
    });
  });
  it("preserves the displayed default effort and shows off for models without reasoning", () => {
    expect(
      effectiveBotModel(bot, {
        ...state,
        catalog: catalog.map((entry) => ({ ...entry, thinkingLevels: ["high"] })),
      })?.thinkingLevel,
    ).toBe("high");
    expect(
      effectiveBotModel(bot, {
        ...state,
        catalog: catalog.map((entry) => ({ ...entry, reasoning: false })),
      })?.thinkingLevel,
    ).toBe("off");
  });
  it("does not invent a model before one is configured", () => {
    expect(
      effectiveBotModel(bot, { ...state, me: { defaultProvider: null, defaultModel: null } }),
    ).toBeNull();
  });
});

it("the quiet chip opens settings and refreshes the space default after settings close", async () => {
  const onClick = vi.fn();
  function ShellModels({ settingsOpen, active = bot }: { settingsOpen: boolean; active?: Bot }) {
    const modelSettings = useModelSettings("space-test", settingsOpen);
    return <BotModelChip bot={active} settings={modelSettings} onClick={onClick} />;
  }
  const chip = (settingsOpen: boolean) => <ShellModels settingsOpen={settingsOpen} />;
  await act(async () => root.render(chip(false)));
  const button = container.querySelector("button");
  expect(button?.textContent).toBe("Ardur · Codex · GPT-6 Astra · mediumdefault");
  expect(button?.getAttribute("aria-label")).toBe(
    "Change model: Ardur · Codex · GPT-6 Astra · medium",
  );
  await act(async () => button?.click());
  expect(onClick).toHaveBeenCalledOnce();
  await act(async () =>
    root.render(
      <ShellModels
        settingsOpen={false}
        active={{
          ...bot,
          id: "bot-next",
          modelProvider: "openai-codex",
          modelId: "gpt-5.3-codex-spark",
        }}
      />,
    ),
  );
  expect(container.textContent).toContain("gpt-5.3-codex-spark · not available");
  expect(container.textContent).not.toContain("default");
  expect(api.list).toHaveBeenCalledOnce();
  expect(api.me).toHaveBeenCalledOnce();
  expect(api.credentials).toHaveBeenCalledOnce();
  await act(async () => root.render(chip(true)));
  api.me.mockResolvedValue({ ...me, defaultModel: "gpt-6-sol" });
  await act(async () => root.render(chip(false)));
  expect(container.textContent).toContain("gpt-6-sol · medium");
});

it("offers model recovery for a parsed provider error", async () => {
  const onChangeModel = vi.fn();
  await act(async () =>
    root.render(
      <ProviderErrorMessage
        text={'{"detail":"Model not supported"}'}
        onChangeModel={onChangeModel}
      />,
    ),
  );
  expect(container.textContent).toBe("Model not supportedChange model");
  await act(async () => container.querySelector("button")?.click());
  expect(onChangeModel).toHaveBeenCalledOnce();
});

it("opens and focuses Model from the chip and recovery with the execution card loading", async () => {
  let resolveStatus!: (status: ComputerStatus) => void;
  api.status.mockReturnValue(
    new Promise<ComputerStatus>((resolve) => {
      resolveStatus = resolve;
    }),
  );
  function ModelRecovery() {
    const [open, setOpen] = useState(false);
    const [focusRequest, setFocusRequest] = useState(0);
    const openModel = () => {
      setFocusRequest((request) => request + 1);
      setOpen(true);
    };
    return (
      <>
        <BotModelChip bot={bot} settings={{ me, catalog, credentials }} onClick={openModel} />
        <ProviderErrorMessage text="Model not supported" onChangeModel={openModel} />
        {open ? (
          <>
            <button type="button" onClick={() => setOpen(false)}>
              Close panel
            </button>
            <BotSettings
              {...settings().props}
              modelSettings={{ me, catalog, credentials }}
              modelFocusRequest={focusRequest}
            />
          </>
        ) : null}
      </>
    );
  }
  await act(async () => root.render(<ModelRecovery />));
  expect(container.querySelector('[data-testid="bot-settings"]')).toBeNull();
  const chip = container.querySelector<HTMLButtonElement>('button[aria-label^="Change model:"]')!;
  await act(async () => chip.click());
  expect(document.activeElement).toBe(modelSelect());
  expect(container.textContent).toContain("Where this bot runs");
  expect(api.status).toHaveBeenCalledWith({ botId: bot.id });
  expect(container.querySelector('[data-testid="runtime-summary"]')).toBeNull();
  expect(modelSelect().closest("details")).toBeNull();
  expect(modelSelect().scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  await act(async () =>
    resolveStatus({
      botId: bot.id,
      kind: "desktop",
      mode: "team",
      state: "stopped",
    } as ComputerStatus),
  );
  expect(container.querySelector('[data-testid="runtime-summary"]')?.textContent).toContain(
    "Runs as you",
  );
  expect(document.activeElement).toBe(modelSelect());
  const close = () =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Close panel",
    )!;
  await act(async () => close().click());
  await act(async () => chip.click());
  expect(document.activeElement).toBe(modelSelect());
  await act(async () => close().click());
  const recovery = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Change model",
  )!;
  await act(async () => recovery.click());
  expect(document.activeElement).toBe(modelSelect());
  expect(onSave).not.toHaveBeenCalled();
});

it("does not show a model action for unrelated errors or a missing bot", async () => {
  await act(async () =>
    root.render(
      <ProviderErrorMessage text={'{"message":"Rate limit exceeded"}'} onChangeModel={vi.fn()} />,
    ),
  );
  expect(container.textContent).toBe("Rate limit exceeded");
  expect(container.querySelector("button")).toBeNull();
  await act(async () => root.render(<ProviderErrorMessage text="Unknown model" />));
  expect(container.querySelector("button")).toBeNull();
});

it("reveals subscription models without changing the saved pin and describes effort", async () => {
  await act(async () =>
    root.render(
      settings({ modelProvider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "xhigh" }),
    ),
  );
  const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(toggle?.parentElement?.textContent).toBe("Show all models");
  await act(async () => toggle?.click());
  const spark = [...modelSelect().options].find(
    (option) => parseModelPinOptionKey(option.value)?.modelId === "gpt-5.3-codex-spark",
  );
  expect(spark?.textContent).toContain("May not be available on your plan");
  expect(modelSelect().value).toBe("openai-codex::gpt-6-astra");
  const effort = container.querySelector<HTMLSelectElement>('select[id$="-thinking"]');
  expect(effort?.closest("details")).toBeNull();
  expect(effort?.textContent).toContain("xhigh — very slow, very careful");
  await act(async () => {
    modelSelect().value = modelPinOptionKey(
      "openai-codex",
      "gpt-5.3-codex-spark",
      "credential-test",
    );
    modelSelect().dispatchEvent(new Event("change", { bubbles: true }));
  });
  await save();
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ modelId: "gpt-5.3-codex-spark" }));
  await act(async () => toggle?.click());
  expect(modelSelect().value).toBe(
    modelPinOptionKey("openai-codex", "gpt-5.3-codex-spark", "credential-test"),
  );
});

it("keeps disconnected and missing-catalog pins and effort during unrelated saves", async () => {
  api.credentials.mockResolvedValue([]);
  await act(async () =>
    root.render(
      settings({ modelProvider: "openai-codex", modelId: "missing-model", thinkingLevel: "xhigh" }),
    ),
  );
  expect(modelSelect().selectedOptions[0]?.textContent).toContain("not available on your account");
  await save();
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      modelProvider: "openai-codex",
      modelId: "missing-model",
      thinkingLevel: "xhigh",
    }),
  );
});

it("uses Shell metadata for the panel without loading it again", async () => {
  const props = settings().props;
  await act(async () =>
    root.render(<BotSettings {...props} modelSettings={{ me, catalog, credentials }} />),
  );
  expect(modelSelect().options.length).toBeGreaterThan(1);
  expect(api.list).not.toHaveBeenCalled();
  // The execution card reads deployment metadata, not the model catalog.
  expect(api.status).toHaveBeenCalledOnce();
  expect(api.me).toHaveBeenCalledOnce();
  expect(api.credentials).not.toHaveBeenCalled();
});

it("offers recovery from the event kind, even when the message cannot be classified", async () => {
  await act(async () =>
    root.render(
      <ProviderErrorMessage
        text="Access denied"
        providerErrorKind="model-unavailable"
        onChangeModel={vi.fn()}
      />,
    ),
  );
  expect(container.querySelector("button")?.textContent).toBe("Change model");
  await act(async () =>
    root.render(
      <ProviderErrorMessage
        text="Model not supported"
        providerErrorKind="other"
        onChangeModel={vi.fn()}
      />,
    ),
  );
  expect(container.querySelector("button")).toBeNull();
});

it("trusts a ready deployment default without claiming a disconnected bot pin is available", () => {
  const state = { me: { ...me, needsModel: false }, catalog, credentials: [] };
  expect(effectiveBotModel(bot, state)?.unavailable).toBe(false);
  expect(
    effectiveBotModel(
      { ...bot, modelProvider: me.defaultProvider, modelId: me.defaultModel },
      state,
    )?.unavailable,
  ).toBe(true);
  expect(
    effectiveBotModel(bot, { ...state, me: { ...state.me, defaultModel: "gpt-5.3-codex-spark" } })
      ?.unavailable,
  ).toBe(true);
});

it("marks a pin missing from a connected catalog as unavailable", () => {
  expect(
    effectiveBotModel(
      { ...bot, modelProvider: "openai-codex", modelId: "missing-model" },
      { me, catalog, credentials },
    )?.unavailable,
  ).toBe(true);
});

it("renders a typed pin failure with labels and both repair actions", async () => {
  const connect = vi.fn();
  const change = vi.fn();
  await act(async () =>
    root.render(
      <ProviderErrorMessage
        text="opaque failure"
        catalog={catalog}
        runtimeProblem={{
          kind: "problem",
          code: "pin-credential-missing",
          pin: {
            provider: "openai-codex",
            modelId: "gpt-6-astra",
            effort: "high",
            credentialId: "deleted",
            runtimeKind: "pi" as const,
            revision: 1,
          },
          reason: "The connection was deleted.",
          actions: ["connect", "change-pin"],
        }}
        onConnect={connect}
        onChangeModel={change}
      />,
    ),
  );
  expect(container.querySelector("span")?.textContent).toBe(
    "This bot is pinned to OpenAI Codex · GPT-6 Astra · high; connect it or change the pin.",
  );
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent)).toEqual(["Connect", "Change pin"]);
  await act(async () => {
    buttons[0]!.click();
    buttons[1]!.click();
  });
  expect(connect).toHaveBeenCalledOnce();
  expect(change).toHaveBeenCalledOnce();
});

it("shows the requested unsupported effort instead of the nearest supported level", () => {
  const model = effectiveBotModel(
    {
      ...bot,
      modelProvider: "openai-codex",
      modelId: "gpt-6-astra",
      modelCredentialId: "credential-test",
      thinkingLevel: "max",
    },
    { me, catalog, credentials },
  );
  expect(model).toMatchObject({ thinkingLevel: "max", unavailable: true });
});

it("keeps same-name custom endpoints distinct and saves the selected connection", async () => {
  api.credentials.mockResolvedValue([
    {
      id: "first",
      provider: "openai-compatible",
      label: "First server",
      hasKey: true,
      modelId: "same-model",
      isDefault: true,
    },
    {
      id: "second",
      provider: "openai-compatible",
      label: "Second server",
      hasKey: true,
      modelId: "same-model",
      isDefault: false,
    },
  ]);
  await act(async () => root.render(settings()));
  const options = [...modelSelect().options].filter(
    (option) => parseModelPinOptionKey(option.value)?.modelId === "same-model",
  );
  expect(options).toHaveLength(2);
  await act(async () => {
    modelSelect().value = options[1]!.value;
    modelSelect().dispatchEvent(new Event("change", { bubbles: true }));
  });
  await save();
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      modelProvider: "openai-compatible",
      modelId: "same-model",
      modelCredentialId: "second",
    }),
  );
});

it("keeps unsupported effort visible and unchanged during profile saves", async () => {
  api.list.mockResolvedValue(
    catalog.map((entry) => ({ ...entry, reasoning: false, thinkingLevels: ["off"] })),
  );
  await act(async () =>
    root.render(
      settings({
        modelProvider: "openai-codex",
        modelId: "gpt-6-astra",
        modelCredentialId: "credential-test",
        thinkingLevel: "high",
      }),
    ),
  );
  expect(container.querySelector<HTMLSelectElement>('select[id$="-thinking"]')?.value).toBe("high");
  await save();
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ thinkingLevel: "high", modelCredentialId: "credential-test" }),
  );
});

it("shows the saved native runtime in the header and its availability sentence in settings", async () => {
  api.availability.mockResolvedValue({
    runtimeKind: "claude-code",
    available: false,
    reason: "Not signed in — run `claude` in a terminal once",
    models: [{ id: "claude-opus-5", label: "Opus 5", efforts: ["low"] }],
  });
  const native = {
    ...bot,
    runtimeKind: "claude-code" as const,
    modelProvider: "anthropic",
    modelId: "claude-opus-5",
    thinkingLevel: "low" as const,
    modelCredentialId: "native:claude-code",
  };
  await act(async () =>
    root.render(<BotModelChip bot={native} settings={null} onClick={vi.fn()} />),
  );
  expect(container.textContent).toBe("Claude Code · claude-opus-5 · low · requested");
  await act(async () => root.render(settings(native)));
  expect(container.textContent).toContain("Not signed in — run `claude` in a terminal once");
  const runsOn = container.querySelector<HTMLSelectElement>('select[id$="-runtime"]');
  expect(runsOn?.value).toBe("claude-code");
  expect(modelSelect().value).toBe("claude-opus-5");
  expect(modelSelect().textContent).not.toContain("GPT-6 Astra");
  expect(container.textContent).toContain("Experimental");
});

it("saves Antigravity suffix effort and explicit no-effort null", async () => {
  api.availability.mockResolvedValue({
    runtimeKind: "antigravity",
    available: true,
    version: "1.2.12",
    signInStatus: "unknown",
    models: [
      { id: "gemini-3.8-flash-low", label: "Low", efforts: ["low"] },
      { id: "claude-sonnet-4-6", label: "No effort", efforts: [] },
    ],
  });
  const native = {
    ...bot,
    runtimeKind: "antigravity" as const,
    modelProvider: "antigravity",
    modelId: "gemini-3.8-flash-low",
    modelCredentialId: "native:antigravity",
    thinkingLevel: "low" as const,
  };
  await act(async () => root.render(settings(native)));
  expect(container.querySelector('select[id$="-effort"]')).toBeNull();
  const select = modelSelect();
  await act(async () => {
    select.value = "claude-sonnet-4-6";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await save();
  expect(onSave).toHaveBeenLastCalledWith(
    expect.objectContaining({ modelId: "claude-sonnet-4-6", thinkingLevel: null }),
  );
  await act(async () => {
    select.value = "gemini-3.8-flash-low";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await save();
  expect(onSave).toHaveBeenLastCalledWith(
    expect.objectContaining({ modelId: "gemini-3.8-flash-low", thinkingLevel: "low" }),
  );
});

it("offers and saves high from the probed native effort list, retaining the pin on recheck", async () => {
  const native = {
    ...bot,
    runtimeKind: "claude-code" as const,
    modelProvider: "anthropic",
    modelId: "claude-opus-5",
    modelCredentialId: "native:claude-code",
    thinkingLevel: "low" as const,
    modelPinRevision: 1,
  };
  api.availability.mockResolvedValue({
    runtimeKind: "claude-code",
    available: true,
    version: "2.1.281",
    models: [
      { id: native.modelId, label: "Opus 5", efforts: ["low", "medium", "high", "xhigh", "max"] },
    ],
  });
  await act(async () => root.render(settings(native)));
  const select = container.querySelector<HTMLSelectElement>('select[id$="-effort"]')!;
  expect([...select.options].map((option) => option.value)).toEqual([
    "",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  await act(async () => {
    select.value = "high";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await save();
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      runtimeKind: "claude-code",
      thinkingLevel: "high",
      modelId: "claude-opus-5",
    }),
  );
  api.availability.mockResolvedValue({
    runtimeKind: "claude-code",
    available: false,
    version: "2.2.0",
    models: [{ id: native.modelId, label: "Opus 5", efforts: ["low"] }],
  });
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Check again")!
      .click(),
  );
  expect(select.value).toBe("high");
  expect(select.selectedOptions[0]?.textContent).toBe("high — not available");
});

it.each([false, true, undefined])(
  "labels the current Claude pin using effort evidence %s",
  async (effortAttested) => {
    const native = {
      ...bot,
      runtimeKind: "claude-code" as const,
      modelProvider: "anthropic",
      modelId: "claude-opus-5",
      modelCredentialId: "native:claude-code",
      thinkingLevel: "high" as const,
      modelPinRevision: 1,
    };
    const run = {
      runtimePin: {
        runtimeKind: native.runtimeKind,
        provider: native.modelProvider,
        modelId: native.modelId,
        effort: native.thinkingLevel,
        credentialId: native.modelCredentialId,
        revision: 1,
      },
      runtimeInfo: { runtimeKind: native.runtimeKind, effortAttested },
    };
    await act(async () =>
      root.render(
        <BotModelChip bot={native} run={run} settings={null} onClick={vi.fn()} display="using" />,
      ),
    );
    expect(container.textContent).toBe(
      `Claude Code · claude-opus-5 · high${effortAttested ? "" : " · requested"}`,
    );
    await act(async () =>
      root.render(
        <BotModelChip
          bot={{ ...native, modelPinRevision: 2 }}
          run={run}
          settings={null}
          onClick={vi.fn()}
          display="using"
        />,
      ),
    );
    expect(container.textContent).toContain("high · requested");
  },
);

it.each([
  ["claude-code", "claude is not installed on this computer"],
  ["codex-app-server", "Codex app-server unavailable"],
] as const)(
  "shows %s availability without replacing the saved model",
  async (runtimeKind, reason) => {
    api.availability.mockResolvedValue({ runtimeKind, available: false, reason, models: [] });
    await act(async () =>
      root.render(
        settings({
          runtimeKind,
          modelProvider: runtimeKind === "claude-code" ? "anthropic" : "openai-codex",
          modelId: "saved-model",
          thinkingLevel: "low",
          modelCredentialId: `native:${runtimeKind}`,
        }),
      ),
    );
    expect(container.textContent).toContain(reason);
    expect(modelSelect().value).toBe("saved-model");
  },
);

describe("Ollama pin visibility", () => {
  it("does not resurrect a missing installed model from its saved default", () => {
    const settings = {
      me: { defaultProvider: "ollama", defaultModel: "qwen3:8b" },
      catalog: [],
      credentials: [
        {
          id: "connection",
          provider: "ollama",
          modelId: "qwen3:8b",
          label: "Ollama",
          hasKey: true,
          isDefault: true,
        },
      ],
    };
    expect(
      effectiveBotModel(
        {
          ...bot,
          modelProvider: "ollama",
          modelId: "qwen3:8b",
          modelCredentialId: "connection",
          thinkingLevel: "low",
        },
        settings,
      ),
    ).toMatchObject({ unavailable: true });
  });
  it("labels null effort as not applicable for non-thinking Ollama models", () => {
    const settings = {
      me: { defaultProvider: "ollama", defaultModel: "llama3.2:1b" },
      catalog: [
        {
          provider: "ollama",
          providerName: "Ollama",
          id: "llama3.2:1b",
          label: "llama3.2:1b",
          billing: "",
          reasoning: false,
          thinkingLevels: [],
        },
      ],
      credentials: [
        {
          id: "connection",
          provider: "ollama",
          modelId: "llama3.2:1b",
          label: "Ollama",
          hasKey: true,
          isDefault: true,
        },
      ],
    };
    expect(
      effectiveBotModel(
        {
          ...bot,
          modelProvider: "ollama",
          modelId: "llama3.2:1b",
          modelCredentialId: "connection",
          thinkingLevel: null,
        },
        settings,
      ),
    ).toMatchObject({ unavailable: false, effortLabel: "not applicable" });
  });
});

it("offers only binary thinking controls under Local and saves null for a non-thinking model", async () => {
  const ollamaModels: ModelCatalogEntry[] = [
    {
      provider: "ollama",
      providerName: "Ollama",
      id: "qwen3:8b",
      label: "qwen3:8b · 8.2B",
      billing: "",
      reasoning: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      credentialId: "connection",
    },
    {
      provider: "ollama",
      providerName: "Ollama",
      id: "llama3.2:1b",
      label: "llama3.2:1b · 1B",
      billing: "",
      reasoning: false,
      thinkingLevels: [],
      credentialId: "connection",
    },
  ];
  api.list.mockResolvedValue(ollamaModels);
  api.credentials.mockResolvedValue([
    {
      id: "connection",
      provider: "ollama",
      modelId: "qwen3:8b",
      label: "Ollama",
      hasKey: true,
      isDefault: true,
    },
  ]);
  await act(async () =>
    root.render(
      settings({
        modelProvider: "ollama",
        modelId: "qwen3:8b",
        modelCredentialId: "connection",
        thinkingLevel: "low",
      }),
    ),
  );
  const effort = container.querySelector<HTMLSelectElement>('select[id$="-thinking"]')!;
  expect([...effort.options].map((option) => option.textContent)).toEqual(["Off", "On"]);
  expect(effort.value).toBe("medium");
  expect(modelSelect().querySelector('optgroup[label="Local"]')?.textContent).toContain(
    "qwen3:8b · 8.2B",
  );
  await act(async () => {
    modelSelect().value = modelPinOptionKey("ollama", "llama3.2:1b", "connection");
    modelSelect().dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("Effort: not applicable");
  expect(container.querySelector('select[id$="-thinking"]')).toBeNull();
  await save();
  expect(onSave).toHaveBeenLastCalledWith(
    expect.objectContaining({
      modelProvider: "ollama",
      modelId: "llama3.2:1b",
      thinkingLevel: null,
    }),
  );
});

it("shows a fresh native probe's version, sign-in and models after Check again", async () => {
  api.availability.mockResolvedValueOnce({
    runtimeKind: "codex-app-server",
    available: false,
    version: "0.156.1",
    signedIn: false,
    models: [],
    reason: "Not signed in — run codex login.",
  });
  await act(async () =>
    root.render(
      <RuntimeSettings
        kind="codex-app-server"
        onKind={vi.fn()}
        modelKey=""
        onModel={vi.fn()}
        effort=""
        onEffort={vi.fn()}
        experimental
        onExperimental={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain("Not signed in — run codex login.");
  api.availability.mockResolvedValueOnce({
    runtimeKind: "codex-app-server",
    available: true,
    version: "0.156.1",
    signedIn: true,
    models: [{ id: "gpt-6-astra", label: "GPT-6 Astra", efforts: ["xhigh"] }],
  });
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Check again")!
      .click(),
  );
  expect(container.textContent).toContain("0.156.1 · Signed in");
  expect(container.textContent).toContain("GPT-6 Astra");
  expect(container.textContent).not.toContain("Not signed in");
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Connect"),
  ).toBe(false);
});

it("shows Hermes beside other runtimes while keeping the shared connection on Pi switching", async () => {
  api.availability.mockResolvedValue({ runtimeKind: "pi", available: true, models: [] });
  const onKind = vi.fn();
  const onModel = vi.fn();
  const onEffort = vi.fn();
  await act(async () =>
    root.render(
      <RuntimeSettings
        kind="pi"
        onKind={onKind}
        modelKey={modelPinOptionKey("ollama", "llama3.2:1b", "connection")}
        onModel={onModel}
        effort="off"
        onEffort={onEffort}
        experimental={false}
        onExperimental={vi.fn()}
      />,
    ),
  );
  const runtime = container.querySelector<HTMLSelectElement>('select[id$="-runtime"]')!;
  expect([...runtime.options].some((option) => option.value === "hermes")).toBe(true);
  await act(async () => {
    runtime.value = "hermes";
    runtime.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onKind).toHaveBeenCalledWith("hermes");
  expect(onModel).not.toHaveBeenCalled();
  expect(onEffort).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Connect Hermes");
});

it("reads and saves only Hermes limits with the existing model pin", async () => {
  api.availability.mockResolvedValue({
    runtimeKind: "hermes",
    available: false,
    reason: "Hermes is not installed on this computer.",
    models: [],
  });
  await act(async () =>
    root.render(
      settings({
        runtimeKind: "hermes",
        runtimeExperimental: true,
        runtimeConfig: { version: 1, maxProviderRequests: 7, timeoutMs: 42_000 },
        modelProvider: "ollama",
        modelId: "llama3.2:1b",
        modelCredentialId: "connection",
        thinkingLevel: null,
      }),
    ),
  );
  await vi.waitFor(
    () =>
      expect(
        container.querySelector<HTMLInputElement>('input[type="number"][max="64"]')?.value,
      ).toBe("7"),
    { timeout: 5_000 },
  );
  expect(container.textContent).toContain("Hermes is not installed on this computer.");
  expect(container.textContent).toContain("Hermes runs with this computer's access.");
  expect(api.validatePin).toHaveBeenCalledWith(
    expect.objectContaining({
      runtimeKind: "hermes",
      provider: "ollama",
      modelId: "llama3.2:1b",
      credentialId: "connection",
    }),
  );
  expect(container.querySelector<HTMLInputElement>('input[type="number"][max="600"]')?.value).toBe(
    "42",
  );
  expect(container.textContent).not.toContain("Connect Hermes");
  const callLimit = container.querySelector<HTMLInputElement>('input[type="number"][max="64"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(callLimit, "8");
    callLimit.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await save();
  expect(onSave).toHaveBeenLastCalledWith(
    expect.objectContaining({
      runtimeKind: "hermes",
      modelProvider: "ollama",
      modelId: "llama3.2:1b",
      modelCredentialId: "connection",
      expectedModelPinRevision: 0,
      runtimeConfig: {
        version: 2,
        runtimeKind: "hermes",
        limits: { maxProviderRequests: 8, timeoutMs: 42_000 },
        context: { maxInputBytes: 16_384, overflow: "trim" },
        harness: { agent: { api_max_retries: 1 } },
      },
    }),
  );
});

it("blocks saving and shows a validation error for fractional Hermes limits", async () => {
  await act(async () =>
    root.render(settings({ runtimeKind: "hermes", runtimeExperimental: true })),
  );
  await vi.waitFor(() =>
    expect(
      container.querySelector<HTMLInputElement>('input[type="number"][max="64"]'),
    ).not.toBeNull(),
  );
  const calls = container.querySelector<HTMLInputElement>('input[type="number"][max="64"]')!;
  const time = container.querySelector<HTMLInputElement>('input[type="number"][max="600"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(calls, "1.5");
    calls.dispatchEvent(new Event("input", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(time, "1.5");
    time.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(calls.value).toBe("1.5");
  expect(time.value).toBe("1.5");
  expect(container.textContent).toContain("Use a whole number");

  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === "Save",
  ) as HTMLButtonElement;
  expect(button.disabled).toBe(true);

  await act(async () => button.click());
  expect(onSave).not.toHaveBeenCalled();
});

it("retains the validation error when editing another valid limit", async () => {
  api.availability.mockResolvedValue({ runtimeKind: "hermes", available: true, models: [] });
  await act(async () =>
    root.render(settings({ runtimeKind: "hermes", runtimeExperimental: true })),
  );
  await vi.waitFor(() =>
    expect(
      container.querySelector<HTMLInputElement>('input[type="number"][max="64"]'),
    ).not.toBeNull(),
  );
  const calls = container.querySelector<HTMLInputElement>('input[type="number"][max="64"]')!;
  const time = container.querySelector<HTMLInputElement>('input[type="number"][max="600"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(calls, "1.5");
    calls.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("Use a whole number from 1 to 64.");
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === "Save",
  ) as HTMLButtonElement;
  expect(button.disabled).toBe(true);

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(time, "60");
    time.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("Use a whole number from 1 to 64.");
  expect(button.disabled).toBe(true);
});

it("does not block saving another runtime when Hermes limits had an error", async () => {
  api.availability.mockResolvedValue({ runtimeKind: "hermes", available: true, models: [] });
  await act(async () =>
    root.render(settings({ runtimeKind: "hermes", runtimeExperimental: true })),
  );
  await vi.waitFor(() =>
    expect(
      container.querySelector<HTMLInputElement>('input[type="number"][max="64"]'),
    ).not.toBeNull(),
  );
  const calls = container.querySelector<HTMLInputElement>('input[type="number"][max="64"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(calls, "1.5");
    calls.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === "Save",
  ) as HTMLButtonElement;
  expect(button.disabled).toBe(true);

  // Switch runtime to "pi"
  const runtimeSelect = container.querySelector<HTMLSelectElement>('select[id$="-runtime"]')!;
  await act(async () => {
    runtimeSelect.value = "pi";
    runtimeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });

  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ runtimeKind: "pi" }));
});

it("shows no refusal for a key-based Hermes connection and disables sign-ins in the picker", async () => {
  api.availability.mockResolvedValue({ runtimeKind: "hermes", available: true, models: [] });
  await act(async () =>
    root.render(
      settings({
        runtimeKind: "hermes",
        runtimeExperimental: true,
        modelProvider: "anthropic",
        modelId: "claude-opus-5",
        modelCredentialId: "anthropic-connection",
        thinkingLevel: "high",
      }),
    ),
  );
  // A key-based Anthropic connection backs Hermes now: no refusal is shown.
  expect(container.textContent).not.toContain("Claude subscriptions");
  expect(container.textContent).not.toContain("ChatGPT sign-ins");
  expect(container.textContent).not.toContain("Connect Hermes");
  // The ChatGPT sign-in stays listed but cannot be picked for Hermes.
  const modelSelect = container.querySelector<HTMLSelectElement>('select[id$="-model"]')!;
  const codexOptions = [...modelSelect.querySelectorAll("option")].filter((option) =>
    option.value.includes("openai-codex"),
  );
  expect(codexOptions.length).toBeGreaterThan(0);
  expect(codexOptions.every((option) => option.disabled)).toBe(true);
});

it("explains a sign-in Hermes connection with the vendor reason", async () => {
  api.availability.mockResolvedValue({ runtimeKind: "hermes", available: true, models: [] });
  await act(async () =>
    root.render(
      settings({
        runtimeKind: "hermes",
        runtimeExperimental: true,
        modelProvider: "openai-codex",
        modelId: "gpt-6-astra",
        modelCredentialId: "credential-test",
        thinkingLevel: "high",
      }),
    ),
  );
  expect(container.textContent).toContain(
    "ChatGPT sign-ins only work inside Codex; add an OpenAI API key to use GPT models with Hermes.",
  );
});
it.each([
  { available: false, reason: "Codex is not installed.", models: [] },
  {
    available: false,
    reason: "Codex version 0.156.1 is not supported yet.",
    version: "0.156.1",
    models: [],
  },
])("shows the probe failure without offering an unrelated connection: $reason", async (result) => {
  api.availability.mockResolvedValue({
    runtimeKind: "codex-app-server",
    ...result,
  } as RuntimeAvailability);
  await act(async () =>
    root.render(
      <RuntimeSettings
        kind="codex-app-server"
        onKind={vi.fn()}
        modelKey=""
        onModel={vi.fn()}
        effort=""
        onEffort={vi.fn()}
        experimental
        onExperimental={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain(result.reason);
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Connect"),
  ).toBe(false);
});
it("keeps a native pin failure's real reason and offers only Change pin", async () => {
  await act(async () =>
    root.render(
      <ProviderErrorMessage
        text="old generic copy"
        runtimeProblem={{
          kind: "problem",
          code: "pin-model-unknown",
          pin: {
            runtimeKind: "codex-app-server",
            provider: "openai-codex",
            modelId: "gpt-6-astra",
            effort: "xhigh",
            credentialId: "native:codex-app-server",
            revision: 1,
          },
          reason: "The pinned model is unavailable in Codex.",
          actions: ["change-pin"],
        }}
        onChangeModel={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toContain("The pinned model is unavailable in Codex.");
  expect(container.textContent).not.toContain("connect it");
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Change pin",
  ]);
});

it("renders Antigravity's model failure with the pinned model", async () => {
  await act(async () =>
    root.render(
      <ProviderErrorMessage
        text=""
        runtimeProblem={{
          kind: "problem",
          code: "pin-model-unknown",
          pin: {
            runtimeKind: "antigravity",
            provider: "antigravity",
            modelId: "gemini-3.8-flash-low",
            effort: "low",
            credentialId: "native:antigravity",
            revision: 1,
          },
          reason: "unrecognised",
          reasonId: "model-unrecognised",
          actions: ["change-pin"],
        }}
      />,
    ),
  );
  expect(container.textContent).toContain(
    "Antigravity did not recognise the model gemini-3.8-flash-low. Pick a model from its list.",
  );
});

it("focuses the model select when modelFocusRequest is set", async () => {
  await act(async () => root.render(settings({}, 1)));
  expect(document.activeElement).toBe(modelSelect());
});

it("focuses the model select when modelFocusRequest increments from 0", async () => {
  await act(async () => root.render(settings({}, 0)));
  expect(document.activeElement).not.toBe(modelSelect());
  await act(async () => root.render(settings({}, 1)));
  expect(document.activeElement).toBe(modelSelect());
});

it("focuses the model select once it appears after a focus request made for another runtime", async () => {
  await act(async () => root.render(settings({ runtimeKind: "claude-code" }, 1)));
  // The native runtime shows its own model select; the built-in one is not mounted yet.
  const nativeModel = container.querySelector<HTMLSelectElement>('select[id$="-model"]');
  expect(document.activeElement).toBe(document.body);
  const runtime = container.querySelector<HTMLSelectElement>('select[id$="-runtime"]');
  if (!runtime) throw new Error("Missing runtime select");
  await act(async () => {
    runtime.value = "pi";
    runtime.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(nativeModel?.isConnected).toBe(false);
  expect(document.activeElement).toBe(modelSelect());
});

it("two-session lost-update scenario returns a conflict", async () => {
  // Session A opens at rev 4
  await act(async () =>
    root.render(
      settings({
        modelPinRevision: 4,
        runtimeKind: "pi",
        modelId: "gpt-5.3-codex-spark",
        modelProvider: "openai-codex",
      }),
    ),
  );

  // Session A changes draft
  const input = container.querySelector<HTMLInputElement>('input[id$="-title"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "changed",
    );
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // Session B saves, Shell polls rev 5
  await act(async () =>
    root.render(
      settings({
        modelPinRevision: 5,
        runtimeKind: "pi",
        modelId: "gpt-6-astra",
        modelProvider: "openai-codex",
      }),
    ),
  );

  // Session A saves
  await save();

  // It should send rev 4
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ expectedModelPinRevision: 4 }));
});

it("untouched draft follows the refresh", async () => {
  // Session A opens at rev 4
  await act(async () =>
    root.render(
      settings({
        modelPinRevision: 4,
        runtimeKind: "pi",
        modelId: "gpt-5.3-codex-spark",
        modelProvider: "openai-codex",
      }),
    ),
  );

  // Session B saves, Shell polls rev 5
  await act(async () =>
    root.render(
      settings({
        modelPinRevision: 5,
        runtimeKind: "pi",
        modelId: "gpt-6-astra",
        modelProvider: "openai-codex",
      }),
    ),
  );

  // Session A saves
  await save();

  // It should send rev 5 (draft followed refresh)
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ expectedModelPinRevision: 5 }));
});

it("saving after re-seed uses the new revision", async () => {
  // Session A opens at rev 4
  await act(async () =>
    root.render(
      settings({
        modelPinRevision: 4,
        runtimeKind: "pi",
        modelId: "gpt-5.3-codex-spark",
        modelProvider: "openai-codex",
      }),
    ),
  );

  // Session B saves, Shell polls rev 5
  await act(async () =>
    root.render(
      settings({
        modelPinRevision: 5,
        runtimeKind: "pi",
        modelId: "gpt-6-astra",
        modelProvider: "openai-codex",
      }),
    ),
  );

  // Session A changes draft to model-4
  const input = container.querySelector<HTMLInputElement>('input[id$="-title"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "changed 2",
    );
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // Session A saves
  await save();

  // It should send rev 5, having based its edit on the refreshed draft
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ expectedModelPinRevision: 5, title: "changed 2" }),
  );
});

it("advances draft revision from the save response", async () => {
  onSave.mockResolvedValueOnce({ modelPinRevision: 5 });
  await act(async () =>
    root.render(
      settings({
        modelPinRevision: 4,
        runtimeKind: "pi",
        modelId: "gpt-5.3-codex-spark",
        modelProvider: "openai-codex",
      }),
    ),
  );

  const titleInput = container.querySelector<HTMLInputElement>('input[id$="-title"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      titleInput,
      "first edit",
    );
    titleInput.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await save();
  expect(onSave).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedModelPinRevision: 4, title: "first edit" }),
  );

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      titleInput,
      "second edit",
    );
    titleInput.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await save();
  expect(onSave).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedModelPinRevision: 5, title: "second edit" }),
  );
});

it.each([
  failureCategoryMessage("experimental-off", { runtime: "Codex", bot: "this bot" }),
  failureCategoryMessage("computer-unsupported", { runtime: "Codex", bot: "this bot" }),
  failureCategoryMessage("destinations-space", { runtime: "Codex", bot: "this bot" }),
  failureCategoryMessage("connection-missing", { runtime: "Ardur", bot: "this bot" }),
  HERMES_CONTEXT_LIMIT_MESSAGE,
])("blocks bot Save with the exact server sentence: %s", async (sentence) => {
  api.validatePin.mockRejectedValue({ code: "BAD_REQUEST", message: sentence });
  await act(async () => root.render(settings()));
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Save",
  )!;
  expect(button.disabled).toBe(true);
  expect(
    [...container.querySelectorAll('[role="alert"]')].some((item) => item.textContent === sentence),
  ).toBe(true);
  onSave.mockClear();
  await save();
  expect(onSave).not.toHaveBeenCalled();
  expect(api.validatePin).toHaveBeenCalledWith(
    expect.objectContaining({ botId: bot.id, runtimeKind: "pi" }),
  );
});

it("keeps new-bot Create disabled when the space default cannot run", async () => {
  const sentence = failureCategoryMessage("connection-missing", { runtime: "Ardur" });
  api.validatePin.mockRejectedValue({ code: "BAD_REQUEST", message: sentence });
  const create = vi.fn();
  await act(async () =>
    root.render(<CreateBotForm onCreate={create} onCancel={() => undefined} />),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(sentence);
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Create",
  )!;
  expect(button.disabled).toBe(true);
  expect(api.validatePin).toHaveBeenCalledWith(
    expect.objectContaining({ computerLocation: "sandbox", provider: null }),
  );
});

it.each(["hermes", "codex-app-server", "claude-code", "antigravity"] as const)(
  "choosing %s visibly turns Experimental on without silently moving the computer",
  async (kind) => {
    function Form() {
      const [runtimeKind, setKind] = useState<RuntimeAvailability["runtimeKind"]>("pi");
      const [experimental, setExperimental] = useState(false);
      return (
        <RuntimeSettings
          kind={runtimeKind}
          onKind={setKind}
          experimental={experimental}
          onExperimental={setExperimental}
          modelKey=""
          onModel={() => undefined}
          effort=""
          onEffort={() => undefined}
        />
      );
    }
    api.availability.mockResolvedValue({ runtimeKind: kind, available: true, models: [] });
    await act(async () => root.render(<Form />));
    const select = container.querySelector<HTMLSelectElement>('select[id$="-runtime"]')!;
    await act(async () => {
      select.value = kind;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("Experimental turned on for this runtime");
    expect(container.textContent).toContain("Experimental");
    const toggle = container.querySelector<HTMLInputElement>('input[aria-label="Experimental"]')!;
    expect(toggle.checked).toBe(true);
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(false);
    expect(container.textContent).not.toContain("Experimental turned on for this runtime");
  },
);
