import type { RuntimePin } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { resolveReviewerPin, reviewerDestination } from "./learning-pin.js";

it("captures the space default at medium effort and never substitutes for a revoked connection", async () => {
  const scope = { spaceId: "space", userId: "owner" };
  const pin: RuntimePin = {
    provider: "xai",
    modelId: "grok-4.6",
    credentialId: "connection",
    effort: "medium",
    revision: 0,
  };
  const preference = vi.fn(async () => ({
    credential: { id: "connection", provider: "xai" },
    modelId: "grok-4.6",
    isDefault: true,
  }));
  const findCredential = vi.fn(async () => null);
  const load = vi.fn();
  const prisma = {
    spaceModelPreference: { findFirst: preference },
    userModelCredential: { findFirst: findCredential },
  } as unknown as PrismaClient;
  expect(await reviewerDestination(prisma, scope, null)).toEqual(pin);
  preference.mockClear();
  const result = await resolveReviewerPin(
    { prisma, secretStore: { load } as never },
    scope,
    pin,
    [],
  );
  expect(result).toMatchObject({ kind: "problem", code: "pin-credential-missing", pin });
  expect(preference).not.toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ isDefault: true }) }),
  );
  expect(load).not.toHaveBeenCalled();
});
