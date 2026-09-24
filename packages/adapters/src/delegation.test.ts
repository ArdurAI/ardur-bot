import type * as Database from "@ardurbot/db";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { admitDelegation } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { prepareDelegation } from "./delegation.js";
import { checkDelegationExecution } from "./delegation-execution.js";

vi.mock("@ardurbot/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  admitDelegation: vi.fn(async (_tx, input) => ({
    id: "handoff",
    rootTaskId: "root",
    snapshot: input.snapshot,
    differences: [],
  })),
}));
it("inherits the exact resolved snapshot including connection and runtime without calling a resolver", async () => {
  const pin = {
    provider: "scripted",
    modelId: "scripted",
    effort: "off",
    credentialId: "scripted",
    revision: 4,
    runtimeKind: "pi",
  };
  const tx = {
    run: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "parent",
        botId: "bot",
        runtimePin: pin,
        runtimeDestination: { host: "localhost", local: true },
      })),
      findUnique: vi.fn(async () => ({ taskId: "root" })),
    },
    bot: {
      findFirstOrThrow: vi.fn(async () => ({
        computerId: "computer",
        computer: { scope: "dedicated", kind: "test" },
      })),
    },
  } as unknown as Prisma.TransactionClient;
  const resolve = vi.fn();
  const result = await prepareDelegation(
    tx,
    {
      parentRunId: "parent",
      actingBotId: "bot",
      actingName: "Helper",
      spaceId: "space",
      userId: "owner",
      kind: "helper",
      admissionKey: "helper",
      prompt: "Review",
    },
    resolve,
  );
  expect(resolve).not.toHaveBeenCalled();
  expect(result).toMatchObject({ ok: true, runData: { runtimePin: pin } });
  expect(admitDelegation).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      snapshot: expect.objectContaining({
        pin,
        computer: { id: "computer", mode: "dedicated", kind: "test" },
      }),
    }),
  );
});
it("blocks a recipient connector its requester lacks after route resolution", async () => {
  const prisma = {
    run: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "run",
        taskId: "task",
        delegationId: "handoff",
      })),
    },
    delegationRoot: { findUnique: vi.fn(async () => null) },
    remoteAuthorityPolicy: { findMany: vi.fn(async () => []) },
    botMcpServer: {
      findFirst: vi.fn(async () => ({
        allowAllTools: false,
        allowedTools: ["read"],
        server: { enabled: true },
      })),
    },
    delegation: {
      findUniqueOrThrow: vi.fn(async () => ({
        status: "running",
        deadlineAt: new Date(Date.now() + 10000),
        usedTokens: 0,
        reservedTokens: 100,
        authority: {
          scopes: ["ordinary", "consequential"],
          connectors: ["mcp:shared", "mcp:shared:read"],
        },
      })),
    },
  } as unknown as PrismaClient;
  expect(
    await checkDelegationExecution(prisma, "run", "read_file", {
      connectorId: "mcp",
      resourceId: "private",
      toolName: "read",
    }),
  ).toContain("outside the requester's grant");
  expect(
    await checkDelegationExecution(prisma, "run", "read_file", {
      connectorId: "mcp",
      resourceId: "shared",
      toolName: "read",
    }),
  ).toBeUndefined();
  expect(
    await checkDelegationExecution(prisma, "run", "write_file", {
      connectorId: "mcp",
      resourceId: "shared",
      toolName: "write",
    }),
  ).toContain("outside the requester's connector grant");
});
