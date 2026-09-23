import type { AgentRunModel } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { resolveRunModelPin } from "./run-model-pin.js";

const scope = { userId: "user", spaceId: "space" };
const credential = {
  id: "connection",
  userId: "user",
  provider: "xai",
  secretId: "secret",
  label: "xai",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const pin = {
  provider: "xai",
  modelId: "grok-4.6",
  effort: "high",
  credentialId: "connection",
  revision: 2,
};
function fixture() {
  const findCredential = vi.fn(async () => credential);
  const findPreference = vi.fn(async () => ({ credential, modelId: "grok-4.6", isDefault: true }));
  const loadKey = vi.fn(
    async (): Promise<AgentRunModel> => ({ provider: "xai", id: "grok-4.6", apiKey: "test-key" }),
  );
  const prisma = {
    userModelCredential: { findFirst: findCredential },
    spaceModelPreference: { findFirst: findPreference },
  } as unknown as PrismaClient;
  return { prisma, loadKey, findCredential, findPreference, scope, scripted: false };
}

describe("run pin snapshots", () => {
  it("fails an incomplete recorded snapshot without replacing it with the current bot pin", async () => {
    const f = fixture();
    expect(
      await resolveRunModelPin({
        ...f,
        snapshot: { ...pin, effort: undefined },
        bot: { modelProvider: "other", modelId: "new-model", thinkingLevel: "low" },
      }),
    ).toMatchObject({
      code: "pin-incomplete",
      pin: { provider: pin.provider, modelId: pin.modelId, effort: null, revision: pin.revision },
    });
    expect(f.findCredential).not.toHaveBeenCalled();
    expect(f.loadKey).not.toHaveBeenCalled();
  });
  it("uses a connected space default and retains the bot's explicit effort", async () => {
    const f = fixture();
    expect(await resolveRunModelPin({ ...f, bot: { thinkingLevel: "high" } })).toMatchObject({
      kind: "resolved",
      provider: "xai",
      id: "grok-4.6",
      thinkingLevel: "high",
      pin: { ...pin, revision: 0 },
    });
  });
  it("preserves the displayed inherited effort of a connected default without medium", async () => {
    const f = fixture();
    const inherited = { ...credential, provider: "openrouter" };
    f.findPreference.mockResolvedValue({
      credential: inherited,
      modelId: "z-ai/glm-5.2",
      isDefault: true,
    });
    f.loadKey.mockResolvedValue({
      provider: "openrouter",
      id: "z-ai/glm-5.2",
      apiKey: "test-key",
    });
    expect(await resolveRunModelPin({ ...f, bot: {} })).toMatchObject({
      kind: "resolved",
      thinkingLevel: "high",
      pin: { effort: "high", credentialId: credential.id },
    });
    expect(await resolveRunModelPin({ ...f, bot: { thinkingLevel: "medium" } })).toMatchObject({
      code: "pin-effort-unsupported",
      pin: { effort: "medium" },
    });
  });
  it("uses the persisted selection after a bot's model, effort, and connection change", async () => {
    const f = fixture();
    expect(
      await resolveRunModelPin({
        ...f,
        snapshot: pin,
        bot: {
          modelProvider: "anthropic",
          modelId: "other-model",
          modelCredentialId: "replacement",
          thinkingLevel: "low",
          modelPinRevision: 3,
        },
      }),
    ).toMatchObject({ kind: "resolved", pin, thinkingLevel: "high" });
    expect(f.findCredential).toHaveBeenCalledWith({
      where: { id: "connection", userId: "user", provider: "xai" },
    });
    expect(f.loadKey).toHaveBeenCalledWith(expect.objectContaining({ id: "connection" }), pin);
  });
  it("does not bind a legacy partial pin at runtime", async () => {
    const f = fixture();
    expect(
      await resolveRunModelPin({
        ...f,
        bot: { modelProvider: "xai", modelId: "grok-4.6", thinkingLevel: "high" },
      }),
    ).toMatchObject({ code: "pin-incomplete" });
    expect(f.loadKey).not.toHaveBeenCalled();
    expect(f.findPreference).not.toHaveBeenCalled();
  });
  it("does not replace a deleted snapshot connection with a new same-provider default", async () => {
    const f = fixture();
    f.findCredential.mockResolvedValue(null!);
    expect(await resolveRunModelPin({ ...f, snapshot: pin, bot: {} })).toMatchObject({
      code: "pin-credential-missing",
      pin,
    });
    expect(f.findPreference).not.toHaveBeenCalled();
    expect(f.loadKey).not.toHaveBeenCalled();
  });
  it("rejects unsupported custom endpoint effort using its declared capability", async () => {
    const f = fixture();
    f.findCredential.mockResolvedValue({ ...credential, provider: "openai-compatible" });
    f.findPreference.mockResolvedValue({ credential, modelId: "local-model", isDefault: true });
    f.loadKey.mockResolvedValue({
      provider: "openai-compatible",
      id: "local-model",
      baseUrl: "http://localhost:8080/v1",
      reasoning: false,
    });
    const custom = { ...pin, provider: "openai-compatible", modelId: "local-model" };
    expect(await resolveRunModelPin({ ...f, snapshot: custom, bot: {} })).toMatchObject({
      code: "pin-effort-unsupported",
      pin: custom,
    });
  });
  it("runs a keyless custom connection at its bound endpoint", async () => {
    const f = fixture();
    f.findCredential.mockResolvedValue({ ...credential, provider: "openai-compatible" });
    f.findPreference.mockResolvedValue({ credential, modelId: "local-model", isDefault: true });
    f.loadKey.mockResolvedValue({
      provider: "openai-compatible",
      id: "local-model",
      baseUrl: "http://localhost:8080/v1",
      reasoning: false,
    });
    const custom = { ...pin, provider: "openai-compatible", modelId: "local-model", effort: "off" };
    expect(await resolveRunModelPin({ ...f, snapshot: custom, bot: {} })).toMatchObject({
      kind: "resolved",
      runtimePin: custom,
      baseUrl: "http://localhost:8080/v1",
      thinkingLevel: "off",
    });
    f.findPreference.mockResolvedValue({ credential, modelId: "new-default", isDefault: true });
    expect(
      await resolveRunModelPin({ ...f, snapshot: custom, bot: { modelId: "new-default" } }),
    ).toMatchObject({ kind: "resolved", id: "local-model", runtimePin: custom });
    f.loadKey.mockResolvedValue({ provider: "openai-compatible", id: "local-model" });
    expect(await resolveRunModelPin({ ...f, snapshot: custom, bot: {} })).toMatchObject({
      code: "pin-credential-missing",
    });
  });
});
