import { nativeRuntimeAvailability } from "@ardurbot/adapters";
import type { Actor, RuntimeAvailability } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { botModelPinUpdate } from "./bot-model-pin.js";
import type { RouterDeps } from "./router.js";

vi.mock("@ardurbot/adapters", async (original) => ({
  ...(await original<object>()),
  nativeRuntimeAvailability: vi.fn(),
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
  it("saves a complete native binding without looking up API credentials", async () => {
    const { deps, findFirst } = fixture();
    vi.mocked(nativeRuntimeAvailability).mockResolvedValue({
      runtimeKind: "claude-code",
      available: true,
      models: [{ id: "claude-opus-5", label: "Opus", efforts: ["low"] }],
    });
    expect(
      await botModelPinUpdate(deps, actor, existing, {
        botId: "bot",
        runtimeKind: "claude-code",
        modelProvider: "anthropic",
        modelId: "claude-opus-5",
        thinkingLevel: "low",
      }),
    ).toEqual({
      runtimeKind: "claude-code",
      modelProvider: "anthropic",
      modelId: "claude-opus-5",
      thinkingLevel: "low",
      modelCredentialId: "native:claude-code",
      modelPinRevision: { increment: 1 },
    });
    expect(findFirst).not.toHaveBeenCalled();
  });
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
