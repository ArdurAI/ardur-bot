import { modelPinOptionKey, parseModelPinOptionKey } from "@ardurbot/core";
// @vitest-environment jsdom

import type {
  Bot,
  ModelCatalogEntry,
  ModelCredential,
  RuntimeAvailability,
} from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  credentials: vi.fn(),
  me: vi.fn(),
  availability: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    delegations: { policy: async () => ({ mode: "any" }), setPolicy: async () => ({ ok: true }) },
    models: api,
    runtimes: { availability: api.availability },
    me: api.me,
    voice: { voices: async () => [] },
  },
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

import { useModelSettings } from "../../lib/use-model-settings";
import { BotModelChip, effectiveBotModel } from "./bot-model-chip";
import { BotSettings } from "./bot-panel";
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
  expect(api.me).not.toHaveBeenCalled();
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
  expect(container.textContent).toBe("Claude Code · claude-opus-5 · low");
  await act(async () => root.render(settings(native)));
  expect(container.textContent).toContain("Not signed in — run `claude` in a terminal once");
  const runsOn = container.querySelector<HTMLSelectElement>('select[id$="-runtime"]');
  expect(runsOn?.value).toBe("claude-code");
  expect(modelSelect().value).toBe("claude-opus-5");
  expect(modelSelect().textContent).not.toContain("GPT-6 Astra");
  expect(container.textContent).toContain("Experimental");
});

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
