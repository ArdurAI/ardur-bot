import { builtinAgentTools, parseUpdateBotPatch } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const custom = {
  id: "fixture-vpn",
  label: "Fixture VPN",
  kind: "credentials" as const,
  paths: ["~/fixture-vpn"],
};

function fixture(role: string | null = "owner") {
  let policy: unknown = null;
  let grants: unknown = null;
  const bot = { id: "bot", spaceId: "space", userId: "owner" };
  const queryRaw = vi.fn(
    async (sql: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      if (sql.join("?").includes("FROM spaces"))
        return values[0] === "space" ? [{ protectedLocations: policy }] : [];
      if (sql.join("?").includes('WHERE "spaceId"'))
        return [{ id: bot.id, protectedLocationGrants: grants }];
      if (
        values[0] !== bot.id ||
        values[1] !== bot.spaceId ||
        (values[2] !== undefined && values[2] !== bot.userId)
      )
        return [];
      return [{ id: bot.id, protectedLocationGrants: grants }];
    },
  );
  const tx = {
    $queryRaw: queryRaw,
    bot: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; spaceId: string; userId: string } }) =>
          where.id === bot.id && where.spaceId === bot.spaceId && where.userId === bot.userId
            ? { id: bot.id }
            : null,
      ),
      update: vi.fn(async ({ data }: { data: { protectedLocationGrants: unknown } }) => {
        grants = data.protectedLocationGrants;
        return {};
      }),
    },
    space: {
      update: vi.fn(async ({ data }: { data: { protectedLocations: unknown } }) => {
        policy = data.protectedLocations;
        return {};
      }),
    },
    spaceMember: { findUnique: vi.fn(async () => (role ? { role } : null)) },
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
    const before = { policy, grants };
    try {
      return await callback(tx);
    } catch (error) {
      ({ policy, grants } = before);
      throw error;
    }
  });
  const prisma = { ...tx, $transaction: transaction } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({
      prisma,
      env: { sandboxProvider: "fake", webOrigin: "http://fixture.test" },
    } as unknown as RouterDeps),
  );
  async function call(
    procedure: "protectedLocations" | "patchProtectedLocations",
    input: unknown,
    caller: Actor | null = actor,
  ) {
    const { response } = await handler.handle(
      new Request(`http://fixture.test/rpc/delegations/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: caller } },
    );
    return { status: response.status, body: await response.json() };
  }
  return { call, tx, transaction };
}

describe("protected location procedures", () => {
  it("lets the bot's user grant and revoke, and returns the stored view", async () => {
    const f = fixture("member");
    const first = await f.call("patchProtectedLocations", {
      botId: "bot",
      patch: { grant: ["ssh"] },
    });
    expect(first.status).toBe(200);
    expect(first.body.json).toContainEqual(
      expect.objectContaining({ id: "ssh", granted: true, custom: false }),
    );
    const read = await f.call("protectedLocations", { botId: "bot" });
    expect(read.status).toBe(200);
    expect(read.body).toEqual(first.body);
    const revoked = await f.call("patchProtectedLocations", {
      botId: "bot",
      patch: { revoke: ["ssh"] },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.json).toContainEqual(
      expect.objectContaining({ id: "ssh", granted: false }),
    );
  });

  it("does not let another space member read or change a bot's grants", async () => {
    const f = fixture();
    const other = { ...actor, userId: "other", isDeploymentOwner: true };
    expect(
      (await f.call("patchProtectedLocations", { botId: "bot", patch: { grant: ["ssh"] } }, other))
        .status,
    ).toBe(404);
    expect((await f.call("protectedLocations", { botId: "bot" }, other)).status).toBe(404);
    expect(f.tx.bot.update).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("lets a space %s add and remove custom locations", async (role) => {
    const f = fixture(role);
    const added = await f.call("patchProtectedLocations", { patch: { add: [custom] } });
    expect(added.status).toBe(200);
    expect(added.body.json.at(-1)).toEqual({ ...custom, custom: true, granted: false });
    expect((await f.call("protectedLocations", {})).body).toEqual(added.body);
    expect(
      (await f.call("patchProtectedLocations", { botId: "bot", patch: { grant: [custom.id] } }))
        .status,
    ).toBe(200);
    expect(
      (await f.call("patchProtectedLocations", { patch: { remove: [custom.id] } })).status,
    ).toBe(200);
    expect((await f.call("patchProtectedLocations", { patch: { add: [custom] } })).status).toBe(
      200,
    );
    const read = await f.call("protectedLocations", { botId: "bot" });
    expect(read.body.json.at(-1)).toMatchObject({ id: custom.id, granted: false });
  });

  it.each(["member", null])(
    "refuses space edits from role %s, even for a deployment owner",
    async (role) => {
      const f = fixture(role);
      expect(
        (
          await f.call(
            "patchProtectedLocations",
            { patch: { add: [custom] } },
            { ...actor, isDeploymentOwner: true },
          )
        ).status,
      ).toBe(403);
      expect(f.transaction).not.toHaveBeenCalled();
    },
  );

  it("refuses unknown ids and invalid or mixed-scope patches", async () => {
    const f = fixture();
    for (const input of [
      { botId: "bot", patch: { grant: ["unknown"] } },
      { botId: "bot", patch: { grant: ["ssh"], revoke: ["ssh"] } },
      { botId: "bot", patch: { grant: Array(129).fill("ssh") } },
      { botId: "bot", patch: { add: [custom] } },
      { patch: { grant: ["ssh"] } },
      { patch: { remove: ["ssh"] } },
      { patch: { add: [{ ...custom, paths: ["~/.aws"] }] } },
      { botId: "bot", patch: { grant: ["ssh"], extra: true } },
      { botId: "bot", patch: {}, userId: "other" },
    ])
      expect((await f.call("patchProtectedLocations", input)).status).toBe(400);
    expect(f.tx.bot.update).not.toHaveBeenCalled();
    expect(f.tx.space.update).not.toHaveBeenCalled();
  });

  it("isolates bot and space lookups from other spaces", async () => {
    const f = fixture();
    const otherSpace = { ...actor, spaceId: "other-space" };
    expect((await f.call("protectedLocations", {}, otherSpace)).status).toBe(404);
    expect(
      (await f.call("patchProtectedLocations", { botId: "bot", patch: {} }, otherSpace)).status,
    ).toBe(404);
  });

  it.each(["protectedLocations", "patchProtectedLocations"] as const)(
    "requires authentication for %s",
    async (procedure) => {
      const f = fixture();
      expect(
        (await f.call(procedure, procedure === "protectedLocations" ? {} : { patch: {} }, null))
          .status,
      ).toBe(401);
      expect(f.transaction).not.toHaveBeenCalled();
    },
  );

  it("keeps grant and policy fields out of the bot's settings tool", () => {
    const update = builtinAgentTools.find(({ name }) => name === "update_bot");
    expect(update).toBeDefined();
    expect(update!.inputSchema.properties).not.toHaveProperty("protectedLocationGrants");
    expect(update!.inputSchema.properties).not.toHaveProperty("protectedLocations");
    expect(
      parseUpdateBotPatch(
        {
          name: "Fixture",
          protectedLocationGrants: ["ssh"],
          protectedLocations: { version: 1, custom: [custom] },
        },
        "Fixture",
      ),
    ).toEqual({ patch: { name: "Fixture" } });
    expect(builtinAgentTools.some(({ name }) => /protected.?locations?/i.test(name))).toBe(false);
  });
});
