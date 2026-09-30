import type { AgentRunModel } from "@ardurbot/adapter-kit";
import { effectiveRuntimeConfigHash } from "@ardurbot/core/node/runtime-config-hash";
import type { PrismaClient } from "@ardurbot/db";
import { compileHermesRuntimeConfig } from "@ardurbot/host-runtime/runtimes/hermes-config";
import { describe, expect, it, vi } from "vitest";
import { effectiveHermesConfig, hermesConfigHash } from "./hermes-compatibility.js";
import { resolveModelApiKey } from "./pi-oauth.js";
import { catalogModels } from "./pi-runtime.js";
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
function fixture(overrides?: { spacePolicy?: unknown }) {
  const findCredential = vi.fn(async () => credential);
  const findPreference = vi.fn(async () => ({ credential, modelId: "grok-4.6", isDefault: true }));
  const loadKey = vi.fn(
    async (): Promise<AgentRunModel> => ({ provider: "xai", id: "grok-4.6", apiKey: "test-key" }),
  );
  const prisma = {
    space: {
      findUnique: vi.fn(async () => ({ allowedModelDestinations: overrides?.spacePolicy ?? null })),
    },
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
  it.each(["primary", "group", "delegated", "comparison"])(
    "captures a dispatchable Hermes manifest for %s admission",
    async (path) => {
      const f = fixture();
      f.findCredential.mockResolvedValue({ ...credential, provider: "openai-compatible" });
      f.loadKey.mockResolvedValue({
        provider: "openai-compatible",
        id: "same-model",
        baseUrl: "http://127.0.0.1:8080/v1",
        thinkingLevel: "off",
        maxTokens: 16_384,
      });
      const config = effectiveHermesConfig(null);
      const choice = {
        ...pin,
        runtimeKind: "hermes" as const,
        provider: "openai-compatible",
        modelId: "same-model",
        effort: "off",
        runtimeConfig: config,
        runtimeConfigHash: hermesConfigHash(config),
      };
      const result = await resolveRunModelPin({
        ...f,
        bot:
          path === "group"
            ? {}
            : {
                runtimeKind: "hermes",
                modelProvider: choice.provider,
                modelId: choice.modelId,
                thinkingLevel: choice.effort,
                modelCredentialId: choice.credentialId,
                modelPinRevision: choice.revision,
                runtimeConfig: config,
              },
        ...(path === "group" ? { snapshot: choice } : {}),
        newAdmission: true,
        ...(path === "delegated" ? { maxOutputTokens: 10_000 } : {}),
      });
      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") return;
      expect(result.contextWindow).toBe(32_768);
      expect(result.maxTokens).toBe(path === "delegated" ? 10_000 : 16_384);
      expect(result.pin.effectiveRuntimeConfig?.model).toMatchObject({
        contextWindow: result.contextWindow,
        maxTokens: result.maxTokens,
      });
      expect(result.pin.effectiveRuntimeConfigHash).toMatch(/^[a-f0-9]{64}$/);
    },
  );
  it.each(["primary", "group", "delegated"])(
    "admits a key-based catalog connection for Hermes on %s admission, and again on resume",
    async (path) => {
      // The stored secret of a key-based connection is the key and nothing else: its limits
      // live in the registry.
      const f = fixture();
      const catalog = catalogModels().getModel(pin.provider, pin.modelId);
      expect(catalog?.maxTokens).toBeGreaterThan(4_096);
      const config = effectiveHermesConfig(null);
      const choice = {
        ...pin,
        runtimeKind: "hermes" as const,
        runtimeConfig: config,
        runtimeConfigHash: hermesConfigHash(config),
      };
      const admitted = await resolveRunModelPin({
        ...f,
        bot:
          path === "group"
            ? {}
            : {
                runtimeKind: "hermes",
                modelProvider: choice.provider,
                modelId: choice.modelId,
                thinkingLevel: choice.effort,
                modelCredentialId: choice.credentialId,
                modelPinRevision: choice.revision,
                runtimeConfig: config,
              },
        ...(path === "group" ? { snapshot: choice } : {}),
        newAdmission: true,
        ...(path === "delegated" ? { maxOutputTokens: 10_000 } : {}),
      });
      expect(admitted).toMatchObject({ kind: "resolved" });
      if (admitted.kind !== "resolved") return;
      expect(admitted.contextWindow).toBe(catalog?.contextWindow);
      expect(admitted.maxTokens).toBe(
        path === "delegated" ? 10_000 : Math.min(catalog?.maxTokens ?? 0, 65_536),
      );
      expect(admitted.pin.effectiveRuntimeConfig?.model).toMatchObject({
        contextWindow: admitted.contextWindow,
        maxTokens: admitted.maxTokens,
      });
      // A retry or a resume reads the recorded pin and resolves the same way.
      expect(await resolveRunModelPin({ ...f, bot: {}, snapshot: admitted.pin })).toMatchObject({
        kind: "resolved",
        maxTokens: admitted.maxTokens,
      });
      // A connection that can now produce less than was recorded still fails closed.
      f.loadKey.mockResolvedValue({
        provider: pin.provider,
        id: pin.modelId,
        apiKey: "test-key",
        maxTokens: 1_024,
      });
      expect(await resolveRunModelPin({ ...f, bot: {}, snapshot: admitted.pin })).toMatchObject({
        kind: "problem",
        code: "runtime-configuration-invalid",
      });
    },
  );
  it("rejects a resumed Hermes pin when the connection capabilities changed", async () => {
    const f = fixture();
    f.findCredential.mockResolvedValue({ ...credential, provider: "openai-compatible" });
    f.loadKey.mockResolvedValue({
      provider: "openai-compatible",
      id: "same-model",
      baseUrl: "http://127.0.0.1:8080/v1",
      thinkingLevel: "off",
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    const config = effectiveHermesConfig(null);
    const choice = {
      ...pin,
      runtimeKind: "hermes" as const,
      provider: "openai-compatible",
      modelId: "same-model",
      effort: "off",
      runtimeConfig: config,
      runtimeConfigHash: hermesConfigHash(config),
    };
    const captured = await resolveRunModelPin({
      ...f,
      bot: {},
      snapshot: choice,
      newAdmission: true,
    });
    expect(captured.kind).toBe("resolved");
    if (captured.kind !== "resolved") return;
    f.loadKey.mockResolvedValue({
      provider: "openai-compatible",
      id: "same-model",
      baseUrl: "http://127.0.0.1:8080/v1",
      thinkingLevel: "off",
      contextWindow: 16_384,
      maxTokens: 4_096,
    });
    expect(await resolveRunModelPin({ ...f, bot: {}, snapshot: captured.pin })).toMatchObject({
      kind: "problem",
      code: "runtime-configuration-invalid",
    });
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
  ).toMatchObject({
    kind: "problem",
    code: "locality-denied",
    reasonId: "destinations-bot",
    reason:
      "this bot's allowed model destinations block this model. Change them in this bot's settings.",
    actions: ["change-pin"],
  });
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

it("names the space policy when the bot's allows but the space's blocks", async () => {
  const f = fixture({ spacePolicy: { mode: "local" } });
  expect(
    await resolveRunModelPin({
      ...f,
      snapshot: pin,
      bot: { allowedModelDestinations: { mode: "any" } },
    }),
  ).toMatchObject({
    kind: "problem",
    code: "locality-denied",
    reasonId: "destinations-space",
    reason: "This space's model policy blocks this model. Change it in Settings, under Models.",
    actions: ["change-pin"],
  });
  // Both block: the bot's policy is named first.
  expect(
    await resolveRunModelPin({
      ...f,
      snapshot: pin,
      bot: { allowedModelDestinations: { mode: "local" } },
    }),
  ).toMatchObject({
    kind: "problem",
    reasonId: "destinations-bot",
  });
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

it("an unchanged connection resolves without a mismatch (executor delegation / brief maintenance)", async () => {
  const f = fixture();
  f.findCredential.mockResolvedValue({ ...credential, provider: "openai-compatible" });
  const connectionModel = {
    provider: "openai-compatible",
    id: "deepseek-v3",
    baseUrl: "https://api.example.com",
    apiKey: "test",
    maxTokens: 16384, // True connection capability
    contextWindow: 32768,
    thinkingLevel: "off" as const,
    reasoning: false,
    acceptsImages: false,
  };
  f.loadKey.mockResolvedValue(connectionModel);

  const config = effectiveHermesConfig(null);
  const compiled = compileHermesRuntimeConfig(config, connectionModel as any);

  const pinParent = {
    ...pin,
    provider: "openai-compatible",
    modelId: "deepseek-v3",
    effort: "off" as const,
    runtimeKind: "hermes" as const,
    runtimeConfig: config,
    runtimeConfigHash: hermesConfigHash(config),
    effectiveRuntimeConfig: compiled.manifest,
    effectiveRuntimeConfigHash: effectiveRuntimeConfigHash(compiled.manifest),
  };

  // Delegated run resolving with a lower caller allowance (10000 max tokens)
  const resolvedDelegated = await resolveRunModelPin({
    ...f,
    maxOutputTokens: 10000,
    snapshot: pinParent,
    bot: { modelPinRevision: 2, runtimeKind: "hermes" as const },
  });

  expect(resolvedDelegated.kind).toBe("resolved");
  if (resolvedDelegated.kind === "resolved") {
    expect(resolvedDelegated.maxTokens).toBe(16384);
  }

  // Brief maintenance resolving without caller allowance
  const resolvedBrief = await resolveRunModelPin({
    ...f,
    snapshot: pinParent,
    bot: { modelPinRevision: 2, runtimeKind: "hermes" as const },
  });
  expect(resolvedBrief.kind).toBe("resolved");
});

it("a genuinely reduced connection still fails closed", async () => {
  const f = fixture();
  f.findCredential.mockResolvedValue({ ...credential, provider: "openai-compatible" });
  const originalConnectionModel = {
    provider: "openai-compatible",
    id: "deepseek-v3",
    baseUrl: "https://api.example.com",
    apiKey: "test",
    maxTokens: 16384,
    contextWindow: 32768,
    thinkingLevel: "off" as const,
    reasoning: false,
    acceptsImages: false,
  };
  const config = effectiveHermesConfig(null);
  const compiled = compileHermesRuntimeConfig(config, originalConnectionModel as any);

  const pinParent = {
    ...pin,
    provider: "openai-compatible",
    modelId: "deepseek-v3",
    effort: "off" as const,
    runtimeKind: "hermes" as const,
    runtimeConfig: config,
    runtimeConfigHash: hermesConfigHash(config),
    effectiveRuntimeConfig: compiled.manifest,
    effectiveRuntimeConfigHash: effectiveRuntimeConfigHash(compiled.manifest),
  };

  // The connection NOW reports a smaller maxTokens capability than the captured one
  f.loadKey.mockResolvedValue({
    provider: "openai-compatible",
    id: "deepseek-v3",
    baseUrl: "https://api.example.com",
    apiKey: "test",
    maxTokens: 8192,
    contextWindow: 32768,
    thinkingLevel: "off" as const,
  });

  const resolved = await resolveRunModelPin({
    ...f,
    maxOutputTokens: 10000,
    snapshot: pinParent,
    bot: { modelPinRevision: 2, runtimeKind: "hermes" as const },
  });
  expect(resolved.kind).toBe("problem");
  if (resolved.kind === "problem") {
    expect(resolved.code).toBe("runtime-configuration-invalid");
  }
});
