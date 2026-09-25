import { BoardService } from "@ardurbot/adapters";
import { expect, it, vi } from "vitest";

it("round-trips bot upkeep through the board service the API calls", async () => {
  let enabled = true;
  const prisma = {
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
    spaceMember: { findUnique: vi.fn(async () => ({ userId: "owner" })) },
    user: { findUniqueOrThrow: vi.fn(async () => ({ name: "Owner" })) },
    space: {
      findUnique: vi.fn(async () => ({ botUpkeep: enabled })),
      update: vi.fn(async ({ data }: { data: { botUpkeep: boolean } }) => {
        enabled = data.botUpkeep;
        return { botUpkeep: enabled };
      }),
    },
  };
  const service = new BoardService({ prisma: prisma as never, dataDir: "/fixture" });
  const scope = { userId: "owner", spaceId: "space" };
  expect(await service.upkeep(scope)).toEqual({ enabled: true });
  expect(await service.setUpkeep(scope, false)).toEqual({ enabled: false });
  expect(enabled).toBe(false);
  expect(await service.upkeep(scope)).toEqual({ enabled: false });
  expect(await service.setUpkeep(scope, true)).toEqual({ enabled: true });
});
