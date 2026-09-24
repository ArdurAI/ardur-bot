import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { createSystemSettings } from "./settings.js";

function fixture() {
  const policies = [{ layer: "space", subjectId: "space", scopes: ["read"] }];
  const prisma = {
    remoteAuthorityPolicy: {
      findMany: vi.fn(async ({ where }) =>
        policies.filter((p) => p.layer === where.layer && p.subjectId === where.subjectId),
      ),
      upsert: vi.fn(async ({ create }) => {
        const current = policies.find(
          (p) => p.layer === create.layer && p.subjectId === create.subjectId,
        );
        if (current) current.scopes = create.scopes;
        else policies.push(create);
      }),
    },
  };
  const actor = { userId: "owner", spaceId: "space", isDeploymentOwner: true } as Actor;
  return {
    prisma,
    policies,
    actor,
    settings: createSystemSettings(prisma as unknown as PrismaClient),
  };
}
describe("space Dispatch settings", () => {
  it("persists the selected space without widening independent restrictions", async () => {
    const f = fixture();
    expect(await f.settings.get(f.actor)).toEqual({ enabled: true, canChange: true });
    expect(await f.settings.set(f.actor, false)).toEqual({ enabled: false, canChange: true });
    expect(await f.settings.get({ ...f.actor, spaceId: "another-space" })).toEqual({
      enabled: true,
      canChange: true,
    });
    expect(await f.settings.set(f.actor, true)).toEqual({ enabled: true, canChange: true });
    expect(f.policies[0]?.scopes).toEqual(["read"]);
    expect(f.prisma.remoteAuthorityPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { layer_subjectId: { layer: "desktop-dispatch", subjectId: "space" } },
      }),
    );
  });
  it("allows members to read but only the owner to change Dispatch", async () => {
    const f = fixture(),
      member = { ...f.actor, isDeploymentOwner: false };
    expect((await f.settings.get(member)).canChange).toBe(false);
    await expect(f.settings.set(member, false)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.prisma.remoteAuthorityPolicy.upsert).not.toHaveBeenCalled();
  });
});
