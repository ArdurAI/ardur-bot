import { randomUUID } from "node:crypto";
import type { AdapterContext, ConnectorCall } from "@ardurbot/adapter-kit";
import { createDb } from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTask } from "../tasks/catalog.js";
import { DepartmentServices, initializeFixtureDatabase } from "./services.js";

const url = process.env.SCOREBOARD_TEST_DATABASE_URL;
describe.skipIf(!url)("disposable department state boundaries", () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      !/^\/scoreboard_trial_\d+$/.test(parsed.pathname)
    )
      throw new Error("Disposable scoreboard database required");
    db = createDb(url!);
    await initializeFixtureDatabase(db.prisma);
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });
  async function fixture() {
    const service = new DepartmentServices();
    const botId = randomUUID();
    await service.seed(db.prisma, getTask("task-04"), botId);
    const context: AdapterContext = {
      botId,
      spaceId: "fixture-space",
      userId: "fixture-user",
      operationId: "fixture",
      traceId: "fixture",
      signal: new AbortController().signal,
      connectedConnections: [
        {
          connectorId: "composio",
          externalId: "SCOREBOARD:1",
          id: "fixture-connection",
          displayName: "Synthetic task records",
        },
      ],
    };
    const call: ConnectorCall = {
      tool: "SCOREBOARD_UPDATE",
      args: { id: "case-a", revision: 7, value: { status: "resolved" } },
      executionId: "effect-a",
    };
    const execute = async (override: Partial<ConnectorCall> = {}) => {
      const events = [];
      for await (const event of service.execute({ ...call, ...override }, context))
        events.push(event);
      return events;
    };
    return { service, context, call, execute };
  }
  it("commits one of two racing revisions and never duplicates the effect", async () => {
    const { service, execute } = await fixture();
    const outcomes = await Promise.allSettled([execute(), execute({ executionId: "effect-b" })]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await service.effects()).toEqual([{ id: "case-a", revision: 8, authorized: true }]);
    expect((await service.snapshot()).find((row) => row.id === "case-b")).toEqual({
      id: "case-b",
      revision: 2,
      value: { status: "open" },
    });
  });
  it("revokes consent after discovery and refuses a stale cached tool catalog", async () => {
    const { service, context, execute } = await fixture();
    expect(
      (await service.discoverTools(context)).some((tool) => tool.name === "SCOREBOARD_UPDATE"),
    ).toBe(true);
    await service.revokeConsent("case-a");
    await expect(execute()).rejects.toThrow("revoked");
    expect(await service.effects()).toEqual([]);
  });
  it("rolls back a duplicate receipt and refuses other scopes", async () => {
    const { service, context, call, execute } = await fixture();
    await execute();
    await expect(execute({ args: { ...call.args, revision: 8 } })).rejects.toThrow();
    expect((await service.snapshot()).find((row) => row.id === "case-a")!.revision).toBe(8);
    const other = service.execute(
      { ...call, executionId: "other" },
      { ...context, botId: "other-bot" },
    );
    await expect(other[Symbol.asyncIterator]().next()).rejects.toThrow("permission");
  });
});
