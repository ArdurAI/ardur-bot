import type { AgentRunModel } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { effectiveHermesConfig, hermesConfigHash } from "./hermes-compatibility.js";
import { resolveModelApiKey } from "./pi-oauth.js";
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
  runtimeKind: "pi" as const,
  revision: 2,
};
function fixture() {
  const findCredential = vi.fn(async () => credential);
  const findPreference = vi.fn(async () => ({ credential, modelId: "grok-4.6", isDefault: true }));
  const loadKey = vi.fn(
    async (): Promise<AgentRunModel> => ({ provider: "xai", id: "grok-4.6", apiKey: "test-key" }),
  );
  const prisma = {
    space: { findUnique: vi.fn(async () => ({ allowedModelDestinations: null })) },
    userModelCredential: { findFirst: findCredential },
    spaceModelPreference: { findFirst: findPreference },
  } as unknown as PrismaClient;
  return { prisma, loadKey, findCredential, findPreference, scope, scripted: false };
}

describe("run pin snapshots", () => {
  it("rejects a saved Hermes connection above the host output ceiling", async () => {
    const f = fixture();
    f.findCredential.mockResolvedValue({ ...credential, provider: "openai-compatible" });
    f.loadKey.mockResolvedValue({
      provider: "openai-compatible",
      id: "same-model",
      baseUrl: "http://127.0.0.1:8080/v1",
      maxTokens: 131_072,
      thinkingLevel: "off",
    });
    const config = effectiveHermesConfig(null);
    const snapshot = {
      ...pin,
      runtimeKind: "hermes" as const,
      provider: "openai-compatible",
      modelId: "same-model",
      effort: "off",
      runtimeConfig: config,
      runtimeConfigHash: hermesConfigHash(config),
    };
    expect(await resolveRunModelPin({ ...f, snapshot, bot: {} })).toMatchObject({
      kind: "problem",
      code: "runtime-configuration-invalid",
    });
  });
  it("keeps a Hermes connection and limits immutable across bot edits", async () => {
    const f = fixture();
    f.findCredential.mockResolvedValue({ ...credential, provider: "openai-compatible" });
    f.loadKey.mockResolvedValue({
      provider: "openai-compatible",
      id: "same-model",
      baseUrl: "http://127.0.0.1:8080/v1",
      thinkingLevel: "off",
    });
    const runtimeConfig = {
      version: 1,
      maxProviderRequests: 7,
      timeoutMs: 42_000,
    } as const;
    const snapshot = {
      ...pin,
      runtimeKind: "hermes" as const,
      provider: "openai-compatible",
      modelId: "same-model",
      effort: "off",
      runtimeConfig,
      runtimeConfigHash: hermesConfigHash(runtimeConfig),
    };
    expect(
      await resolveRunModelPin({
        ...f,
        snapshot,
        bot: { runtimeKind: "pi", modelCredentialId: "other", runtimeConfig: null },
      }),
    ).toMatchObject({ kind: "resolved", pin: snapshot });
    expect(f.findCredential).toHaveBeenCalledWith({
      where: { id: "connection", userId: "user", provider: "openai-compatible" },
    });
    f.findCredential.mockResolvedValue(null!);
    expect(await resolveRunModelPin({ ...f, snapshot, bot: {} })).toMatchObject({
      code: "pin-credential-missing",
    });
    expect(
      await resolveRunModelPin({
        ...f,
        snapshot: { ...snapshot, runtimeConfigHash: "0".repeat(64) },
        bot: {},
      }),
    ).toMatchObject({ code: "runtime-configuration-invalid" });
  });
  it("upgrades a v1 group choice only for new admission and keeps the historical hash", async () => {
    const f = fixture();
    f.findCredential.mockResolvedValue({ ...credential, provider: "openai-compatible" });
    f.loadKey.mockResolvedValue({
      provider: "openai-compatible",
      id: "same-model",
      baseUrl: "http://127.0.0.1:8080/v1",
      thinkingLevel: "off",
      contextWindow: 32768,
      maxTokens: 4096,
    });
    const config = { version: 1 as const, maxProviderRequests: 7, timeoutMs: 42000 };
    const snapshot = {
      ...pin,
      runtimeKind: "hermes" as const,
      provider: "openai-compatible",
      modelId: "same-model",
      effort: "off",
      runtimeConfig: config,
      runtimeConfigHash: hermesConfigHash(config),
    };
    const historical = await resolveRunModelPin({ ...f, snapshot, bot: {} });
    expect(historical).toMatchObject({ kind: "resolved", pin: snapshot });
    expect(historical.pin).not.toHaveProperty("effectiveRuntimeConfig");
    const admitted = await resolveRunModelPin({ ...f, snapshot, bot: {}, newAdmission: true });
    expect(admitted).toMatchObject({
      kind: "resolved",
      pin: {
        runtimeConfig: { version: 2, limits: { maxProviderRequests: 7, timeoutMs: 42000 } },
        effectiveRuntimeConfig: { profile: { profile: "hermes-ardur-v2" } },
      },
    });
    expect(admitted.pin.runtimeConfigHash).not.toBe(snapshot.runtimeConfigHash);
    expect(admitted.pin.effectiveRuntimeConfigHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.runtimeConfig.version).toBe(1);
  });
  it("keeps an Anthropic pin and returns a reconnect action for legacy OAuth", async () => {
    const f = fixture();
    f.findCredential.mockResolvedValue({ ...credential, provider: "anthropic" });
    const snapshot = { ...pin, provider: "anthropic", modelId: "claude-opus-5" };
    const refresh = vi.fn();
    const toAuth = vi.fn();
    f.loadKey.mockImplementation(async () => ({
      provider: snapshot.provider,
      id: snapshot.modelId,
      apiKey: await resolveModelApiKey(
        JSON.stringify({ access: "test-access", refresh: "test-refresh", expires: 1 }),
        "anthropic",
        {
          oauth: { refresh, toAuth },
        },
      ),
    }));
    expect(await resolveRunModelPin({ ...f, snapshot, bot: {} })).toMatchObject({
      kind: "problem",
      code: "pin-credential-missing",
      pin: snapshot,
      reason: "Reconnect with an API key.",
      actions: ["connect", "change-pin"],
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(toAuth).not.toHaveBeenCalled();
    expect(f.findPreference).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isDefault: true }) }),
    );
  });
  it("resolves a null legacy snapshot from the backfilled bot pin", async () => {
    const f = fixture();
    expect(
      await resolveRunModelPin({
        ...f,
        snapshot: null,
        bot: {
          modelProvider: pin.provider,
          modelId: pin.modelId,
          thinkingLevel: pin.effort,
          modelCredentialId: pin.credentialId,
          modelPinRevision: 1,
        },
      }),
    ).toMatchObject({ kind: "resolved", pin: { ...pin, revision: 1 } });
    expect(f.loadKey).toHaveBeenCalledOnce();
  });
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

it("checks root locality against the resolved endpoint before returning an executable pin", async () => {
  const f = fixture();
  expect(
    await resolveRunModelPin({
      ...f,
      snapshot: pin,
      bot: { allowedModelDestinations: { mode: "local" } },
    }),
  ).toMatchObject({ kind: "problem", code: "locality-denied" });
  f.findCredential.mockResolvedValue({ ...credential, provider: "openai-compatible" });
  f.loadKey.mockResolvedValue({
    provider: "openai-compatible",
    id: "local-model",
    baseUrl: "http://localhost:8080/v1",
    reasoning: false,
  });
  const custom = { ...pin, provider: "openai-compatible", modelId: "local-model", effort: "off" };
  expect(
    await resolveRunModelPin({
      ...f,
      snapshot: custom,
      bot: { allowedModelDestinations: { mode: "local" } },
    }),
  ).toMatchObject({ kind: "resolved", runtimePin: custom });
});

it.each(["low", "medium", "high", "xhigh", "max"])(
  "resolves native %s snapshots without looking up or loading a credential",
  async (effort) => {
    const f = fixture();
    const snapshot = {
      ...pin,
      runtimeKind: "claude-code" as const,
      provider: "anthropic",
      modelId: "claude-opus-5",
      effort,
      credentialId: "native:claude-code",
    };
    const result = await resolveRunModelPin({
      ...f,
      snapshot,
      bot: { runtimeKind: "pi", modelProvider: "xai" },
    });
    expect(result).toMatchObject({ kind: "resolved", pin: snapshot, runtimePin: snapshot });
    expect(f.loadKey).not.toHaveBeenCalled();
    expect(f.findCredential).not.toHaveBeenCalled();
    expect(f.findPreference).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("oauth");
  },
);

it.each(["claude-code", "codex-app-server"] as const)(
  "never loads an inherited hosted credential for a %s pin",
  async (runtimeKind) => {
    const f = fixture();
    const provider = runtimeKind === "codex-app-server" ? "openai-codex" : "anthropic";
    const native = {
      ...pin,
      runtimeKind,
      provider,
      modelId: "gpt-6-astra",
      effort: "xhigh",
      credentialId: `native:${runtimeKind}`,
    };
    f.findPreference.mockResolvedValue({
      credential: { ...credential, provider },
      modelId: native.modelId,
      isDefault: true,
    });
    f.loadKey.mockResolvedValue({
      provider,
      id: native.modelId,
      apiKey: "test-inherited-key",
      oauth: {
        credential: { type: "oauth", access: "test-access", refresh: "test-refresh", expires: 0 },
      },
    });
    for (const snapshot of [native, undefined]) {
      const result = await resolveRunModelPin({
        ...f,
        snapshot,
        bot: {
          runtimeKind,
          modelProvider: provider,
          modelId: native.modelId,
          thinkingLevel: "xhigh",
          modelCredentialId: native.credentialId,
          modelPinRevision: native.revision,
        },
      });
      expect(result).toEqual({
        kind: "resolved",
        pin: native,
        runtimePin: native,
        provider,
        id: native.modelId,
        thinkingLevel: "xhigh",
      });
    }
    expect(f.findPreference).not.toHaveBeenCalled();
    expect(f.findCredential).not.toHaveBeenCalled();
    expect(f.loadKey).not.toHaveBeenCalled();
    expect(
      await resolveRunModelPin({
        ...f,
        snapshot: { ...native, credentialId: "explicit-hosted-connection" },
        bot: {},
      }),
    ).toMatchObject({
      kind: "problem",
      code: "runtime-unavailable",
      reason:
        "Native runtimes use their own sign-in. Remove the pinned connection or change the runtime.",
    });
  },
);

it("blocks a native room selection when the bot requires local execution", async () => {
  const f = fixture();
  const native = {
    runtimeKind: "claude-code" as const,
    provider: "anthropic",
    modelId: "native-fixture",
    effort: "low",
    credentialId: "native:claude-code",
    revision: 1,
  };
  expect(
    await resolveRunModelPin({
      ...f,
      snapshot: native,
      bot: { allowedModelDestinations: { mode: "local" } },
    }),
  ).toMatchObject({ kind: "problem", code: "locality-denied", pin: native });
  expect(f.loadKey).not.toHaveBeenCalled();
});
