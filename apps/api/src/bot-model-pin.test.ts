import { listOllamaModels, nativeRuntimeAvailability, showOllamaModel } from "@ardurbot/adapters";
import type { Actor, RuntimeAvailability } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { botModelPinUpdate } from "./bot-model-pin.js";
import { validateModelPinSelection } from "./model-pin-validation.js";
import type { RouterDeps } from "./router.js";

vi.mock("@ardurbot/adapters", async (original) => ({
  ...(await original<object>()),
  nativeRuntimeAvailability: vi.fn(),
  listOllamaModels: vi.fn(),
  showOllamaModel: vi.fn(),
}));

const actor = { userId: "user", spaceId: "space" } as Actor;
const existing = {
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  modelCredentialId: null,
};
function fixture() {
  const credential = {
    id: "selected",
    userId: "user",
    provider: "xai",
    label: "xai",
    secretId: "secret",
    defaultModel: "grok-4.6",
    isDefault: false,
  };
  const findFirst = vi.fn(async () => credential);
  const deps = {
    prisma: {
      userModelCredential: { findFirst },
      spaceModelPreference: {
        findFirst: vi.fn(async () => ({ modelId: "grok-4.6", isDefault: true })),
      },
      secret: { findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "secret" })) },
    },
    secrets: {
      load: () =>
        JSON.stringify({
          kind: "openai_compatible",
          baseUrl: "http://localhost:8080/v1",
          reasoning: false,
        }),
    },
  } as unknown as RouterDeps;
  return { deps, findFirst, credential };
}
describe("bot pin editing", () => {
  it.each([
    { reasoning: false, selected: undefined, saved: null },
    { reasoning: true, selected: "off", saved: "off" },
  ] as const)("saves an Ollama no-thinking choice: %j", async ({ reasoning, selected, saved }) => {
    const { deps, findFirst } = fixture();
    findFirst.mockResolvedValue({
      id: "selected",
      userId: "user",
      provider: "ollama",
      label: "local",
      secretId: "secret",
      defaultModel: "fixture-model",
      isDefault: false,
    });
    vi.mocked(listOllamaModels).mockResolvedValue([{ name: "fixture-model" }]);
    vi.mocked(showOllamaModel).mockResolvedValue({
      id: "fixture-model",
      acceptsImages: false,
      reasoning,
      supportsThinkingOff: true,
      contextWindow: 65_536,
    });
    const update = await botModelPinUpdate(deps, actor, existing, {
      botId: "bot",
      runtimeKind: "hermes",
      modelProvider: "ollama",
      modelId: "fixture-model",
      modelCredentialId: "selected",
      ...(selected ? { thinkingLevel: selected } : {}),
    });
    expect(update).toMatchObject({ runtimeKind: "hermes", thinkingLevel: saved });
  });
  it("keeps an OpenAI-compatible reasoning effort on the Hermes pin", async () => {
    const { deps, findFirst } = fixture();
    vi.mocked(deps.prisma.spaceModelPreference.findFirst).mockResolvedValue({
      modelId: "fixture-model",
      isDefault: false,
    } as never);
    findFirst.mockResolvedValue({
      id: "selected",
      userId: "user",
      provider: "openai-compatible",
      label: "local",
      secretId: "secret",
      defaultModel: "fixture-model",
      isDefault: false,
    });
    vi.spyOn(deps.secrets, "load").mockReturnValue(
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "http://localhost:8080/v1",
        reasoning: true,
        contextWindow: 65_536,
        maxTokens: 4_096,
      }),
    );
    await expect(
      botModelPinUpdate(deps, actor, existing, {
        botId: "bot",
        runtimeKind: "hermes",
        modelProvider: "openai-compatible",
        modelId: "fixture-model",
        modelCredentialId: "selected",
        thinkingLevel: "high",
      }),
    ).resolves.toMatchObject({ runtimeKind: "hermes", thinkingLevel: "high" });
    await expect(
      validateModelPinSelection(deps, actor, {
        runtimeKind: "hermes",
        provider: "openai-compatible",
        modelId: "fixture-model",
        credentialId: "selected",
        effort: "high",
      }),
    ).resolves.toEqual({
      runtimeKind: "hermes",
      provider: "openai-compatible",
      modelId: "fixture-model",
      credentialId: "selected",
      effort: "high",
    });
  });
  it("preserves the exact connected model when switching between Pi and Hermes", async () => {
    const { deps, findFirst } = fixture();
    vi.mocked(deps.prisma.spaceModelPreference.findFirst).mockResolvedValue({
      modelId: "same-model",
      isDefault: false,
    } as never);
    findFirst.mockResolvedValue({
      id: "selected",
      userId: "user",
      provider: "openai-compatible",
      label: "local",
      secretId: "secret",
      defaultModel: "same-model",
      isDefault: false,
    });
    vi.spyOn(deps.secrets, "load").mockReturnValue(
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "http://localhost:11434/v1",
        contextWindow: 65_536,
      }),
    );
    const pinned = {
      ...existing,
      runtimeKind: "pi",
      modelProvider: "openai-compatible",
      modelId: "same-model",
      thinkingLevel: "off",
      modelCredentialId: "selected",
    };
    expect(
      await botModelPinUpdate(deps, actor, pinned, { botId: "bot", runtimeKind: "hermes" }),
    ).toMatchObject({
      runtimeKind: "hermes",
      modelCredentialId: "selected",
      modelId: "same-model",
      thinkingLevel: "off",
      modelPinRevision: { increment: 1 },
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "selected", userId: "user", provider: "openai-compatible" },
    });
    expect(
      await botModelPinUpdate(
        deps,
        actor,
        { ...pinned, runtimeKind: "hermes" },
        { botId: "bot", runtimeKind: "pi" },
      ),
    ).toMatchObject({ runtimeKind: "pi", modelCredentialId: "selected" });
  });

  it("rejects a Pi connection with an output cap above the Hermes host ceiling", async () => {
    const { deps, findFirst } = fixture();
    vi.mocked(deps.prisma.spaceModelPreference.findFirst).mockResolvedValue({
      modelId: "same-model",
      isDefault: false,
    } as never);
    findFirst.mockResolvedValue({
      id: "selected",
      userId: "user",
      provider: "openai-compatible",
      label: "local",
      secretId: "secret",
      defaultModel: "same-model",
      isDefault: false,
    });
    vi.spyOn(deps.secrets, "load").mockReturnValue(
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "http://localhost:8080/v1",
        reasoning: false,
        contextWindow: 131_072,
        maxTokens: 131_072,
      }),
    );
    await expect(
      botModelPinUpdate(
        deps,
        actor,
        {
          ...existing,
          runtimeKind: "pi",
          modelProvider: "openai-compatible",
          modelId: "same-model",
          thinkingLevel: "off",
          modelCredentialId: "selected",
        },
        { botId: "bot", runtimeKind: "hermes" },
      ),
    ).rejects.toThrow("bounded context and output limits");
  });

  it("does not replace a removed Hermes connection with another matching model id", async () => {
    const { deps, findFirst } = fixture();
    findFirst.mockResolvedValue(null!);
    await expect(
      botModelPinUpdate(deps, actor, existing, {
        botId: "bot",
        runtimeKind: "hermes",
        modelProvider: "openai-compatible",
        modelId: "same-model",
        modelCredentialId: "removed",
        thinkingLevel: "off",
      }),
    ).rejects.toThrow("Connect that model provider first");
    expect(deps.prisma.spaceModelPreference.findFirst).not.toHaveBeenCalled();
  });

  it("accepts a key-based catalog connection for Hermes", async () => {
    const { deps } = fixture();
    await expect(
      botModelPinUpdate(deps, actor, existing, {
        botId: "bot",
        runtimeKind: "hermes",
        modelProvider: "xai",
        modelId: "grok-4.6",
        modelCredentialId: "selected",
        thinkingLevel: "medium",
      }),
    ).resolves.toMatchObject({ runtimeKind: "hermes", thinkingLevel: "medium" });
  });
  it("rejects a ChatGPT sign-in for Hermes with the vendor reason", async () => {
    const { deps, findFirst } = fixture();
    findFirst.mockResolvedValue({
      id: "selected",
      userId: "user",
      provider: "openai-codex",
      label: "chatgpt",
      secretId: "secret",
      defaultModel: "gpt-6-astra",
      isDefault: false,
    });
    vi.spyOn(deps.secrets, "load").mockReturnValue(
      JSON.stringify({ type: "oauth", access: "access", refresh: "refresh", expires: 1 }),
    );
    await expect(
      botModelPinUpdate(deps, actor, existing, {
        botId: "bot",
        runtimeKind: "hermes",
        modelProvider: "openai-codex",
        modelId: "gpt-6-astra",
        modelCredentialId: "selected",
        thinkingLevel: "high",
      }),
    ).rejects.toThrow(
      "ChatGPT sign-ins only work inside Codex; add an OpenAI API key to use GPT models with Hermes.",
    );
  });
  it("rejects a Claude subscription for Hermes with the vendor reason", async () => {
    const { deps, findFirst } = fixture();
    findFirst.mockResolvedValue({
      id: "selected",
      userId: "user",
      provider: "anthropic",
      label: "claude",
      secretId: "secret",
      defaultModel: "claude-opus-5",
      isDefault: false,
    });
    vi.spyOn(deps.secrets, "load").mockReturnValue("sk-ant-oat01-fixture-token");
    await expect(
      botModelPinUpdate(deps, actor, existing, {
        botId: "bot",
        runtimeKind: "hermes",
        modelProvider: "anthropic",
        modelId: "claude-opus-5",
        modelCredentialId: "selected",
        thinkingLevel: "high",
      }),
    ).rejects.toThrow(
      "Claude subscriptions only work in Anthropic's own apps; add an Anthropic API key to use Claude with Hermes.",
    );
  });
  it("rejects any other sign-in connection for Hermes with the generic reason", async () => {
    const { deps } = fixture();
    vi.spyOn(deps.secrets, "load").mockReturnValue(
      JSON.stringify({ type: "oauth", access: "access", refresh: "refresh", expires: 1 }),
    );
    await expect(
      botModelPinUpdate(deps, actor, existing, {
        botId: "bot",
        runtimeKind: "hermes",
        modelProvider: "xai",
        modelId: "grok-4.6",
        modelCredentialId: "selected",
        thinkingLevel: "medium",
      }),
    ).rejects.toThrow("Add an API key connection to use this provider with Hermes.");
  });
  it("saves a no-effort Antigravity model with explicit null", async () => {
    const { deps, findFirst } = fixture();
    vi.mocked(nativeRuntimeAvailability).mockResolvedValue({
      runtimeKind: "antigravity",
      available: false,
      models: [
        {
          id: "claude-sonnet-4-6",
          label: "Claude Sonnet 4.6 (Thinking)",
          efforts: [],
          effortMode: "none",
        },
      ],
    });
    expect(
      await botModelPinUpdate(
        deps,
        actor,
        { ...existing, thinkingLevel: "high" },
        {
          botId: "bot",
          runtimeKind: "antigravity",
          modelProvider: "antigravity",
          modelId: "claude-sonnet-4-6",
          thinkingLevel: null,
        },
      ),
    ).toMatchObject({
      runtimeKind: "antigravity",
      thinkingLevel: null,
      modelCredentialId: "native:antigravity",
    });
    expect(findFirst).not.toHaveBeenCalled();
  });
  it.each(["low", "medium", "high", "xhigh", "max"] as const)(
    "saves a complete native %s binding without looking up API credentials",
    async (effort) => {
      const { deps, findFirst } = fixture();
      vi.mocked(nativeRuntimeAvailability).mockResolvedValue({
        runtimeKind: "claude-code",
        available: true,
        models: [
          {
            id: "claude-opus-5",
            label: "Opus",
            efforts: ["low", "medium", "high", "xhigh", "max"],
          },
        ],
      });
      expect(
        await botModelPinUpdate(deps, actor, existing, {
          botId: "bot",
          runtimeKind: "claude-code",
          modelProvider: "anthropic",
          modelId: "claude-opus-5",
          thinkingLevel: effort,
        }),
      ).toEqual({
        runtimeKind: "claude-code",
        modelProvider: "anthropic",
        modelId: "claude-opus-5",
        thinkingLevel: effort,
        modelCredentialId: "native:claude-code",
        modelPinRevision: { increment: 1 },
      });
      expect(findFirst).not.toHaveBeenCalled();
    },
  );
  it("validates model-only edits against the runtime's model and effort capabilities", async () => {
    const { deps } = fixture();
    vi.mocked(nativeRuntimeAvailability).mockResolvedValue({
      runtimeKind: "claude-code",
      available: true,
      models: [{ id: "claude-opus-5", label: "Opus", efforts: ["low"] }],
    });
    await expect(
      botModelPinUpdate(
        deps,
        actor,
        {
          runtimeKind: "claude-code",
          modelProvider: "anthropic",
          modelId: "claude-opus-5",
          thinkingLevel: "low",
          modelCredentialId: "native:claude-code",
        },
        { botId: "bot", modelId: "unknown" },
      ),
    ).rejects.toThrow("cannot honor");
  });
  it("keeps a disconnected native choice explicit instead of choosing another runtime", async () => {
    const { deps, findFirst } = fixture();
    const unavailable: RuntimeAvailability = {
      runtimeKind: "codex-app-server",
      available: false,
      models: [],
      reason: "Codex app-server unavailable",
    };
    vi.mocked(nativeRuntimeAvailability).mockResolvedValue(unavailable);
    expect(
      await botModelPinUpdate(deps, actor, existing, {
        botId: "bot",
        runtimeKind: "codex-app-server",
        modelProvider: "openai-codex",
        modelId: "model",
        thinkingLevel: "high",
      }),
    ).toMatchObject({ runtimeKind: "codex-app-server", modelId: "model", thinkingLevel: "high" });
    expect(findFirst).not.toHaveBeenCalled();
  });
  it("preserves an unchanged legacy pin during a profile save", async () => {
    const { deps, findFirst } = fixture();
    const legacy = { ...existing, modelProvider: "xai", modelId: "grok-4.6" };
    expect(await botModelPinUpdate(deps, actor, legacy, { botId: "bot", ...legacy })).toEqual({});
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("requires a connection choice before changing an unbound legacy pin's effort", async () => {
    const { deps, findFirst } = fixture();
    const legacy = { ...existing, modelProvider: "xai", modelId: "grok-4.6" };
    await expect(
      botModelPinUpdate(deps, actor, legacy, {
        botId: "bot",
        thinkingLevel: "high",
      }),
    ).rejects.toThrow("Choose the connection to use.");
    expect(findFirst).not.toHaveBeenCalled();
    expect(deps.prisma.spaceModelPreference.findFirst).not.toHaveBeenCalled();
    expect(
      await botModelPinUpdate(deps, actor, legacy, {
        botId: "bot",
        thinkingLevel: "high",
        modelCredentialId: "selected",
      }),
    ).toMatchObject({ modelCredentialId: "selected", thinkingLevel: "high" });
  });
  it("materializes a complete choice including suggested effort and a revision", async () => {
    const { deps, findFirst } = fixture();
    expect(
      await botModelPinUpdate(deps, actor, existing, {
        botId: "bot",
        modelProvider: "xai",
        modelId: "grok-4.6",
        modelCredentialId: "selected",
      }),
    ).toEqual({
      runtimeKind: "pi",
      modelProvider: "xai",
      modelId: "grok-4.6",
      modelCredentialId: "selected",
      thinkingLevel: "medium",
      modelPinRevision: { increment: 1 },
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "selected", userId: "user", provider: "xai" },
    });
  });
  it("rejects a deleted binding without selecting another connection", async () => {
    const { deps, findFirst } = fixture();
    findFirst.mockResolvedValue(null!);
    await expect(
      botModelPinUpdate(deps, actor, existing, {
        botId: "bot",
        modelProvider: "xai",
        modelId: "grok-4.6",
        modelCredentialId: "deleted",
      }),
    ).rejects.toThrow("Connect that model provider first");
    expect(deps.prisma.spaceModelPreference.findFirst).not.toHaveBeenCalled();
  });
  it("preserves a disconnected pin during a profile save", async () => {
    const { deps, findFirst } = fixture();
    const pinned = {
      modelProvider: "xai",
      modelId: "grok-4.6",
      thinkingLevel: "high" as const,
      modelCredentialId: "deleted",
    };
    expect(await botModelPinUpdate(deps, actor, pinned, { botId: "bot", ...pinned })).toEqual({});
    expect(findFirst).not.toHaveBeenCalled();
  });
  it("clears the whole binding when choosing the space default", async () => {
    const { deps } = fixture();
    expect(
      await botModelPinUpdate(
        deps,
        actor,
        {
          modelProvider: "xai",
          modelId: "grok-4.6",
          thinkingLevel: "high",
          modelCredentialId: "selected",
        },
        { botId: "bot", modelProvider: null, modelId: null },
      ),
    ).toMatchObject({ modelProvider: null, modelId: null, modelCredentialId: null });
  });
});

it("accepts a no-effort native model for a group member choice", async () => {
  const { deps, findFirst } = fixture();
  vi.mocked(nativeRuntimeAvailability).mockResolvedValue({
    runtimeKind: "antigravity",
    available: false,
    models: [{ id: "claude-sonnet-4-6", label: "Sonnet", efforts: [], effortMode: "none" }],
  });
  const choice = {
    runtimeKind: "antigravity" as const,
    provider: "antigravity",
    modelId: "claude-sonnet-4-6",
    effort: null,
    credentialId: "native:antigravity",
  };
  expect(await validateModelPinSelection(deps, actor, choice)).toEqual(choice);
  expect(findFirst).not.toHaveBeenCalled();
});

it("refuses an explicitly selected hosted credential for a native pin", async () => {
  const f = fixture();
  await expect(
    botModelPinUpdate(f.deps, actor, existing, {
      botId: "bot",
      runtimeKind: "codex-app-server",
      modelProvider: "openai-codex",
      modelId: "gpt-6-astra",
      thinkingLevel: "xhigh",
      modelCredentialId: "hosted-connection",
    }),
  ).rejects.toThrow("Native runtimes use their own sign-in.");
  expect(f.findFirst).not.toHaveBeenCalled();
});
