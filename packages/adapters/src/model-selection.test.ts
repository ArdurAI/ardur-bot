import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { selectConfiguredModel, validateConnectedModelChoice } from "./model-selection.js";

function credential(provider: string, defaultModel: string | null) {
  return {
    id: `credential-${provider}`,
    userId: "user-1",
    provider,
    label: provider,
    secretId: `secret-${provider}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDefault: false,
    defaultModel,
  };
}

const pin = {
  provider: "xai",
  modelId: "grok-4.6",
  effort: "high",
  credentialId: "credential-xai",
  revision: 1,
};
const connected = credential("xai", "grok-4.6");

describe("configured model selection", () => {
  it("honors the complete pin without substitution", () => {
    expect(selectConfiguredModel({ pin, credential: connected })).toMatchObject({
      kind: "resolved",
      pin,
      provider: "xai",
      id: "grok-4.6",
      thinkingLevel: "high",
      credential: connected,
    });
  });
  it("fails on a missing or deleted credential", () => {
    expect(selectConfiguredModel({ pin, credential: null })).toMatchObject({
      kind: "problem",
      code: "pin-credential-missing",
      pin,
      actions: ["connect", "change-pin"],
    });
  });
  it.each(["provider", "modelId", "effort", "credentialId"] as const)(
    "rejects a partial pin missing %s",
    (field) => {
      const requested = { ...pin, [field]: null };
      expect(selectConfiguredModel({ pin: requested, credential: connected })).toMatchObject({
        kind: "problem",
        code: "pin-incomplete",
        pin: requested,
      });
    },
  );
  it.each(["null", "undefined", ""])("rejects a sentinel model %s", (modelId) => {
    expect(
      selectConfiguredModel({ pin: { ...pin, modelId }, credential: connected }),
    ).toMatchObject({ code: "pin-incomplete" });
  });
  it("rejects unknown models instead of selecting the catalog's first", () => {
    expect(
      selectConfiguredModel({ pin: { ...pin, modelId: "not-a-model" }, credential: connected }),
    ).toMatchObject({ code: "pin-model-unknown" });
  });
  it.each(["max", "off", "invented"])(
    "rejects unsupported effort %s without clamping",
    (effort) => {
      expect(
        selectConfiguredModel({ pin: { ...pin, effort }, credential: connected }),
      ).toMatchObject({ code: "pin-effort-unsupported", pin: { effort } });
    },
  );
  it("does not accept another same-provider connection with the same custom model", () => {
    const custom = {
      ...pin,
      provider: "openai-compatible",
      modelId: "same-model",
      effort: "off",
      credentialId: "chosen-server",
    };
    const other = { ...credential("openai-compatible", "same-model"), id: "other-server" };
    expect(selectConfiguredModel({ pin: custom, credential: other })).toMatchObject({
      code: "pin-credential-missing",
      pin: custom,
    });
    expect(
      selectConfiguredModel({ pin: custom, credential: { ...other, id: "chosen-server" } }),
    ).toMatchObject({ kind: "resolved", pin: custom });
  });
});

describe("connected model validation", () => {
  const actor: Pick<Actor, "userId" | "spaceId"> = {
    userId: "user-1",
    spaceId: "space-1",
  };

  it("accepts catalog and saved free-form models but rejects unavailable choices", async () => {
    const catalogPrisma = {
      spaceModelPreference: { findFirst: async () => null },
      userModelCredential: { findFirst: async () => credential("xai", null) },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(catalogPrisma, actor, "xai", "grok-4.6"),
    ).resolves.toBeUndefined();
    await expect(
      validateConnectedModelChoice(catalogPrisma, actor, "xai", "not-a-model"),
    ).resolves.toBe("Unknown model for that provider");

    const preferenceFindFirst = vi.fn(
      async (args: {
        where: {
          spaceId?: string;
          userId?: string;
          modelId?: string;
          credential?: { provider?: string; userId?: string };
        };
      }) => {
        if (args.where.modelId) {
          if (
            args.where.spaceId === actor.spaceId &&
            args.where.userId === actor.userId &&
            args.where.modelId === "private-model" &&
            args.where.credential?.provider === "openai-compatible" &&
            args.where.credential?.userId === actor.userId
          ) {
            return { id: "saved-private-model" };
          }
          return null;
        }
        if (args.where.credential?.provider === "openai-compatible") {
          return {
            credential: credential("openai-compatible", "newest-model"),
            isDefault: true,
            modelId: "newest-model",
          };
        }
        return null;
      },
    );
    const customPrisma = {
      spaceModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: async () => null },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(customPrisma, actor, "openai-compatible", "private-model"),
    ).resolves.toBeUndefined();
    expect(preferenceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: actor.spaceId,
          userId: actor.userId,
          modelId: "private-model",
          credential: { userId: actor.userId, provider: "openai-compatible" },
        }),
        select: { id: true },
      }),
    );
    await expect(
      validateConnectedModelChoice(customPrisma, actor, "openai-compatible", "missing-model"),
    ).resolves.toBe("Unknown model for that provider");

    const disconnectedPrisma = {
      spaceModelPreference: { findFirst: async () => null },
      userModelCredential: { findFirst: async () => null },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(disconnectedPrisma, actor, "anthropic", "claude-opus-4-6"),
    ).resolves.toBe("Connect that model provider first");

    await expect(validateConnectedModelChoice(catalogPrisma, actor, "xai", "null")).resolves.toBe(
      "Unknown model for that provider",
    );
    await expect(
      validateConnectedModelChoice(catalogPrisma, actor, "xai", "undefined"),
    ).resolves.toBe("Unknown model for that provider");
  });
});
