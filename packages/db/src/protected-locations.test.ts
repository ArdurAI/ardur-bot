import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  readProtectedLocations,
  updateBotProtectedLocationGrants,
  updateSpaceProtectedLocations,
} from "./protected-locations.js";
import { IsolationError } from "./scope.js";

const custom = { id: "vpn", label: "VPN", kind: "credentials" as const, paths: ["~/fixture-vpn"] };
const scope = { spaceId: "space", userId: "user", botId: "bot" };

function fixture(policy: unknown = null, grants: unknown = null) {
  const bots = [
    { id: "bot", protectedLocationGrants: grants },
    { id: "other-bot", protectedLocationGrants: ["vpn", "aws"] },
  ];
  const queryRaw = vi.fn(
    async (sql: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> =>
      sql.join("?").includes("FROM spaces") ? [{ protectedLocations: policy }] : bots,
  );
  const tx = {
    $queryRaw: queryRaw,
    bot: { update: vi.fn(async (_input: unknown) => ({})) },
    space: { update: vi.fn(async (_input: unknown) => ({})) },
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
  const prisma = { $transaction: transaction } as unknown as PrismaClient;
  return { prisma, tx, transaction, queryRaw, bots };
}

function sqlCalls(queryRaw: ReturnType<typeof fixture>["queryRaw"]) {
  return queryRaw.mock.calls.map(([sql]) => sql.join("?"));
}

describe("protected locations persistence", () => {
  it("reads defaults with no grants in one transaction under the space lock", async () => {
    const f = fixture();
    const views = await readProtectedLocations(f.prisma, { spaceId: "space" });
    expect(views.find(({ id }) => id === "ssh")).toMatchObject({ custom: false, granted: false });
    expect(f.transaction).toHaveBeenCalledOnce();
    expect(sqlCalls(f.queryRaw)[0]).toContain("FOR SHARE");
    expect(f.queryRaw.mock.calls[0]?.slice(1)).toEqual(["space"]);
    expect(f.tx.bot.update).not.toHaveBeenCalled();
  });

  it("reads bot grants with space isolation and a stable policy", async () => {
    const f = fixture({ version: 1, custom: [custom] }, ["vpn"]);
    f.queryRaw.mockResolvedValueOnce([{ protectedLocations: { version: 1, custom: [custom] } }]);
    f.queryRaw.mockResolvedValueOnce([f.bots[0]!]);
    expect((await readProtectedLocations(f.prisma, scope)).at(-1)).toMatchObject({
      id: "vpn",
      granted: true,
    });
    expect(sqlCalls(f.queryRaw)[1]).toContain("FOR SHARE");
    expect(f.queryRaw.mock.calls[1]?.slice(1)).toEqual(["bot", "space"]);
  });

  it("applies bot deltas after locking the scoped owned bot", async () => {
    const f = fixture(null, ["ssh"]);
    f.queryRaw.mockResolvedValueOnce([{ protectedLocations: null }]);
    f.queryRaw.mockResolvedValueOnce([f.bots[0]!]);
    const views = await updateBotProtectedLocationGrants(f.prisma, {
      ...scope,
      patch: { grant: ["aws"], revoke: ["ssh"] },
    });
    expect(views.find(({ id }) => id === "aws")?.granted).toBe(true);
    expect(views.find(({ id }) => id === "ssh")?.granted).toBe(false);
    expect(sqlCalls(f.queryRaw)[1]).toContain("FOR UPDATE");
    expect(f.queryRaw.mock.calls[1]?.slice(1)).toEqual(["bot", "space", "user"]);
    expect(f.tx.bot.update).toHaveBeenCalledWith({
      where: { id: "bot", spaceId: "space", userId: "user" },
      data: { protectedLocationGrants: ["aws"] },
    });
    expect(f.transaction).toHaveBeenCalledOnce();
  });

  it("rejects an unknown grant without writing", async () => {
    const f = fixture();
    f.queryRaw.mockResolvedValueOnce([{ protectedLocations: null }]);
    f.queryRaw.mockResolvedValueOnce([f.bots[0]!]);
    await expect(
      updateBotProtectedLocationGrants(f.prisma, { ...scope, patch: { grant: ["unknown"] } }),
    ).rejects.toThrow("Unknown protected location");
    expect(f.tx.bot.update).not.toHaveBeenCalled();
  });

  it("adds the policy under an exclusive space lock", async () => {
    const f = fixture();
    expect(
      (
        await updateSpaceProtectedLocations(f.prisma, {
          spaceId: "space",
          patch: { add: [custom] },
        })
      ).at(-1),
    ).toMatchObject({ id: "vpn", custom: true, granted: false });
    expect(sqlCalls(f.queryRaw)[0]).toContain("FOR UPDATE");
    expect(f.tx.space.update).toHaveBeenCalledWith({
      where: { id: "space" },
      data: { protectedLocations: { version: 1, custom: [custom] } },
    });
    expect(f.tx.bot.update).not.toHaveBeenCalled();
  });

  it("removes grants from every space bot in the same transaction, including replacement ids", async () => {
    const f = fixture({ version: 1, custom: [custom] }, ["vpn", "ssh"]);
    await updateSpaceProtectedLocations(f.prisma, {
      spaceId: "space",
      patch: { remove: ["vpn"], add: [custom] },
    });
    expect(sqlCalls(f.queryRaw)[1]).toContain('WHERE "spaceId" = ? ORDER BY id FOR UPDATE');
    expect(f.queryRaw.mock.calls[1]?.slice(1)).toEqual(["space"]);
    expect(f.tx.bot.update.mock.calls).toEqual([
      [{ where: { id: "bot", spaceId: "space" }, data: { protectedLocationGrants: ["ssh"] } }],
      [
        {
          where: { id: "other-bot", spaceId: "space" },
          data: { protectedLocationGrants: ["aws"] },
        },
      ],
    ]);
    expect(f.transaction).toHaveBeenCalledOnce();
  });

  it("does not write an invalid policy or a missing scoped resource", async () => {
    const f = fixture();
    await expect(
      updateSpaceProtectedLocations(f.prisma, { spaceId: "space", patch: { remove: ["ssh"] } }),
    ).rejects.toThrow();
    expect(f.tx.space.update).not.toHaveBeenCalled();
    expect(f.tx.bot.update).not.toHaveBeenCalled();
    f.queryRaw.mockResolvedValueOnce([]);
    await expect(readProtectedLocations(f.prisma, scope)).rejects.toBeInstanceOf(IsolationError);
    f.queryRaw.mockResolvedValueOnce([{ protectedLocations: null }]);
    f.queryRaw.mockResolvedValueOnce([]);
    await expect(
      updateBotProtectedLocationGrants(f.prisma, { ...scope, patch: {} }),
    ).rejects.toBeInstanceOf(IsolationError);
  });
});
