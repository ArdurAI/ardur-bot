// @vitest-environment jsdom

import type { Bot, ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), credentials: vi.fn(), me: vi.fn() }));
vi.mock("../../lib/rpc", () => ({
  rpc: { models: api, me: api.me, voice: { voices: async () => [] } },
}));
vi.mock("./avatar-studio-popover", () => ({ AvatarStudioPopover: () => null }));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => null }));
vi.mock("../KnowledgeSection", () => ({ KnowledgeSection: () => null }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
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
  Toggle: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  Switch: () => null,
}));

import { BotModelChip, effectiveBotModel } from "./bot-model-chip";
import { BotSettings } from "./bot-panel";
import { ProviderErrorMessage } from "./provider-error-message";

const bot: Bot = {
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.list.mockResolvedValue(catalog);
  api.credentials.mockResolvedValue(credentials);
  api.me.mockResolvedValue(me);
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

const onSave = vi.fn(async () => undefined);
function settings(overrides: Partial<Bot> = {}, modelFocusRequest = 0) {
  return (
    <BotSettings
      bot={{ ...bot, ...overrides }}
      modelFocusRequest={modelFocusRequest}
      memoryProviderConfigured={false}
      onSkillsChange={() => undefined}
      onSave={onSave}
      onExport={async () => undefined}
      onClear={() => undefined}
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
  it("does not reintroduce a stored Spark credential as a free-form option", async () => {
    await act(async () => root.render(settings()));
    expect([...modelSelect().options].map((option) => option.value)).toEqual([
      "",
      "openai-codex::gpt-6-astra",
      "openai-codex::gpt-6-sol",
      "openai-codex::gpt-5.5",
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

  it("opens Advanced and focuses the model control on each request", async () => {
    await act(async () => root.render(settings({}, 1)));
    expect(container.querySelector("details")?.open).toBe(true);
    expect(document.activeElement).toBe(modelSelect());
    await act(async () => root.render(settings({}, 2)));
    expect(document.activeElement).toBe(modelSelect());
  });
});

describe("effective bot model", () => {
  const state = { me, catalog, credentials };
  it("shows the catalog label and default reasoning effort", () => {
    expect(effectiveBotModel(bot, state)).toEqual({
      label: "GPT-6 Astra",
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
    ).toEqual({ label: "gpt-6-sol", thinkingLevel: "xhigh", isDefault: false });
  });
  it("falls back when the override provider is disconnected", () => {
    expect(
      effectiveBotModel(
        { ...bot, modelProvider: "disconnected", modelId: "missing", thinkingLevel: "xhigh" },
        state,
      ),
    ).toEqual({ label: "GPT-6 Astra", thinkingLevel: "medium", isDefault: true });
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
    ).toEqual({ label: "custom-model", thinkingLevel: "low", isDefault: true });
  });
  it("clamps to supported thinking and shows off for models without reasoning", () => {
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
  const chip = (settingsOpen: boolean) => (
    <BotModelChip bot={bot} spaceId="space-test" settingsOpen={settingsOpen} onClick={onClick} />
  );
  await act(async () => root.render(chip(false)));
  const button = container.querySelector("button");
  expect(button?.textContent).toBe("GPT-6 Astra · mediumdefault");
  expect(button?.getAttribute("aria-label")).toBe("Change model: GPT-6 Astra · medium");
  await act(async () => button?.click());
  expect(onClick).toHaveBeenCalledOnce();
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
