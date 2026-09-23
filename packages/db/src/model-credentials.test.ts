import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  findBoundModelCredential,
  findDefaultModelCredential,
  findModelCredential,
  findUserModelCredentials,
  newestModelCredentialOrder,
  selectSpaceModelPreference,
} from "./model-credentials.js";

it("lists every same-provider connection only for the requested owner", async () => {
  const findMany = vi.fn().mockResolvedValue([{ id: "first" }, { id: "second" }]);
  const prisma = { userModelCredential: { findMany } } as unknown as PrismaClient;
  expect(await findUserModelCredentials(prisma, "owner", "xai")).toHaveLength(2);
  expect(findMany).toHaveBeenCalledWith({
    where: { userId: "owner", provider: "xai" },
    orderBy: newestModelCredentialOrder,
  });
});

describe("findDefaultModelCredential", () => {
  it("resolves the default from the active space preference", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { spaceModelPreference: { findFirst } } as unknown as PrismaClient;

    await findDefaultModelCredential(prisma, { userId: "user", spaceId: "space" });

    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: "user", spaceId: "space", isDefault: true },
      include: { credential: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
  });

  it("treats a stored stringified null model id as unset", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      credential: {
        id: "credential",
        userId: "user",
        provider: "anthropic",
        label: "Anthropic",
        secretId: "secret",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      isDefault: true,
      modelId: "null",
    });
    const prisma = { spaceModelPreference: { findFirst } } as unknown as PrismaClient;

    await expect(
      findDefaultModelCredential(prisma, { userId: "user", spaceId: "space" }),
    ).resolves.toEqual(
      expect.objectContaining({ id: "credential", provider: "anthropic", defaultModel: null }),
    );
  });
});

describe("findModelCredential", () => {
  it("falls back to the newest user credential when the space has no preference", async () => {
    const preferenceFindFirst = vi.fn().mockResolvedValue(null);
    const credentialFindFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      spaceModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: credentialFindFirst },
    } as unknown as PrismaClient;

    await findModelCredential(prisma, { userId: "user", spaceId: "space" }, "xai");

    expect(preferenceFindFirst).toHaveBeenCalledWith({
      where: { userId: "user", spaceId: "space", credential: { provider: "xai" } },
      include: { credential: true },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    });
    expect(credentialFindFirst).toHaveBeenCalledWith({
      where: { userId: "user", provider: "xai" },
      orderBy: newestModelCredentialOrder,
    });
  });

  it("prefers the preference that owns a free-form modelId over the provider default", async () => {
    const matching = {
      credential: {
        id: "credential-other",
        userId: "user",
        provider: "openai-compatible",
        label: "Other",
        secretId: "secret-other",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      isDefault: false,
      modelId: "other-model",
    };
    const preferenceFindFirst = vi.fn().mockResolvedValue(matching);
    const prisma = {
      spaceModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      findModelCredential(
        prisma,
        { userId: "user", spaceId: "space" },
        "openai-compatible",
        "other-model",
      ),
    ).resolves.toEqual({
      ...matching.credential,
      isDefault: false,
      defaultModel: "other-model",
    });
    expect(preferenceFindFirst).toHaveBeenCalledWith({
      where: {
        userId: "user",
        spaceId: "space",
        modelId: "other-model",
        credential: { provider: "openai-compatible" },
      },
      include: { credential: true },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    });
    expect(preferenceFindFirst).toHaveBeenCalledTimes(1);
  });
});

describe("selectSpaceModelPreference", () => {
  it("clears only a different active default before selecting the credential", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const upsert = vi.fn().mockResolvedValue({ id: "preference" });
    const prisma = { spaceModelPreference: { updateMany, upsert } } as unknown as PrismaClient;

    await selectSpaceModelPreference(
      prisma,
      { userId: "user", spaceId: "space" },
      "credential",
      "model",
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user",
        spaceId: "space",
        isDefault: true,
        credentialId: { not: "credential" },
      },
      data: { isDefault: false },
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ isDefault: true, modelId: "model" }),
        update: { isDefault: true, modelId: "model" },
      }),
    );
  });

  it.each([null, undefined, "null", "undefined", "  null  ", ""])(
    "does not persist %j as a model id",
    async (modelId) => {
      const updateMany = vi.fn().mockResolvedValue({ count: 0 });
      const upsert = vi.fn().mockResolvedValue({ id: "preference" });
      const prisma = { spaceModelPreference: { updateMany, upsert } } as unknown as PrismaClient;

      await selectSpaceModelPreference(
        prisma,
        { userId: "user", spaceId: "space" },
        "credential",
        modelId,
      );

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ modelId: null }),
          update: { isDefault: true, modelId: null },
        }),
      );
    },
  );
});

it("looks up a pinned connection by ID and user even when another endpoint serves the same model", async () => {
  const bound = {
    id: "chosen",
    provider: "openai-compatible",
    userId: "user",
    secretId: "secret",
    label: "Chosen server",
  };
  const findFirst = vi.fn(
    async ({ where }: { where: { id: string; userId: string; provider: string } }) =>
      where.id === bound.id && where.userId === bound.userId ? bound : null,
  );
  const preference = vi.fn(async () => ({ modelId: "same-model", isDefault: false }));
  const prisma = {
    userModelCredential: { findFirst },
    spaceModelPreference: { findFirst: preference },
  } as unknown as PrismaClient;
  expect(
    await findBoundModelCredential(
      prisma,
      { userId: "user", spaceId: "space" },
      "openai-compatible",
      "chosen",
    ),
  ).toMatchObject({ id: "chosen", defaultModel: "same-model" });
  expect(preference).toHaveBeenCalledWith({
    where: { spaceId: "space", userId: "user", credentialId: "chosen" },
  });
  preference.mockClear();
  expect(
    await findBoundModelCredential(
      prisma,
      { userId: "user", spaceId: "space" },
      "openai-compatible",
      "deleted",
    ),
  ).toBeNull();
  expect(
    await findBoundModelCredential(
      prisma,
      { userId: "other-user", spaceId: "space" },
      "openai-compatible",
      "chosen",
    ),
  ).toBeNull();
  expect(preference).not.toHaveBeenCalled();
});
