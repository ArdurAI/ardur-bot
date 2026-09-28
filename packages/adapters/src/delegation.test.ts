import type * as Database from "@ardurbot/db";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { admitDelegation, updateWorkerTask } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { prepareDelegation } from "./delegation.js";
import { checkDelegationExecution } from "./delegation-execution.js";
import { piModelContextWindow } from "./pi-models.js";

vi.mock("@ardurbot/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  admitDelegation: vi.fn(async (_tx, input) => ({
    id: "handoff",
    rootTaskId: "root",
    snapshot: input.snapshot,
    differences: [],
  })),
  updateWorkerTask: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./pi-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pi-models.js")>()),
  piModelContextWindow: vi.fn(() => undefined),
}));
it("passes a one-request floor derived from the worker's pinned model to admission", async () => {
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
  vi.mocked(piModelContextWindow).mockReturnValue(8_192);
  await prepareDelegation(tx, {
    parentRunId: "parent",
    actingBotId: "bot",
    actingName: "Helper",
    spaceId: "space",
    userId: "owner",
    kind: "helper",
    admissionKey: "helper-floor",
    prompt: "Review",
  });
  // A known 8192-token context needs one full context plus one output: 8192 + 4096.
  expect(admitDelegation).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({ minimumTokens: 12_288 }),
  );
  vi.mocked(piModelContextWindow).mockReturnValue(undefined);
  await prepareDelegation(tx, {
    parentRunId: "parent",
    actingBotId: "bot",
    actingName: "Helper",
    spaceId: "space",
    userId: "owner",
    kind: "helper",
    admissionKey: "helper-floor-unknown",
    prompt: "Review",
  });
  // An unknown model gets the standard-context floor: 32768 + 4096.
  expect(admitDelegation).toHaveBeenLastCalledWith(
    tx,
    expect.objectContaining({ minimumTokens: 36_864 }),
  );
});
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
it("freezes a room recipient's selection and provenance at admission", async () => {
  const pin = {
    runtimeKind: "pi" as const,
    provider: "scripted",
    modelId: "scripted",
    effort: "off",
    credentialId: "scripted",
    revision: 6,
  };
  const source = {
    kind: "group-member" as const,
    groupId: "group",
    memberId: "member",
    botId: "recipient",
  };
  const tx = {
    run: {
      findUniqueOrThrow: vi.fn(async () => ({ id: "parent", botId: "sender" })),
      findUnique: vi.fn(async () => ({ taskId: "root" })),
    },
    bot: {
      findFirstOrThrow: vi.fn(async () => ({ id: "recipient", computerId: null, computer: null })),
    },
  } as unknown as Prisma.TransactionClient;
  const resolve = vi.fn(async () => ({
    kind: "resolved" as const,
    pin,
    runtimePin: pin,
    provider: "scripted",
    id: "scripted",
    thinkingLevel: "off" as const,
    pinSource: source,
    usageGroupId: "group",
  }));
  const result = await prepareDelegation(
    tx,
    {
      parentRunId: "parent",
      actingBotId: "recipient",
      actingName: "Recipient",
      spaceId: "space",
      userId: "owner",
      kind: "message",
      admissionKey: "room-recipient",
      prompt: "Continue",
      targetThreadId: "room",
    },
    resolve,
  );
  expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ id: "recipient" }), {
    tx,
    targetThreadId: "room",
    userId: "owner",
    spaceId: "space",
  });
  expect(result).toMatchObject({
    ok: true,
    runData: { runtimePin: pin, runtimePinSource: source, usageGroupId: "group" },
  });
  expect(admitDelegation).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({ snapshot: expect.objectContaining({ pin, pinSource: source }) }),
  );
});
it("blocks a recipient connector its requester lacks after route resolution", async () => {
  const prisma = {
    run: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "run",
        taskId: "task",
        delegationId: "handoff",
        spaceId: "space",
        userId: "owner",
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
        requesterBotId: "requester",
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
it.each(["board_ready", "board_show"])(
  "permits delegated %s with ordinary authority",
  async (tool) => {
    const prisma = {
      run: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "run",
          taskId: "task",
          spaceId: "space",
          delegationId: "handoff",
        })),
      },
      delegationRoot: { findUnique: vi.fn(async () => null) },
      remoteAuthorityPolicy: { findMany: vi.fn(async () => [{ scopes: ["ordinary"] }]) },
      delegation: {
        findUniqueOrThrow: vi.fn(async () => ({
          status: "running",
          deadlineAt: new Date(Date.now() + 60_000),
          usedTokens: 0,
          reservedTokens: 100,
          requesterBotId: "requester",
          actingBotId: "worker",
          authority: { scopes: ["ordinary"], connectors: [] },
        })),
      },
    } as unknown as PrismaClient;
    expect(await checkDelegationExecution(prisma, "run", tool)).toBeUndefined();
    expect(await checkDelegationExecution(prisma, "run", "board_update")).toContain("permission");
  },
);

it("records a blocked card when a peer run forges a hidden tool call", async () => {
  const card = {
    peerMode: "read-only",
    goal: "Check the fixture",
    inputs: [],
    doneWhen: [],
    deadlineAt: null,
    requesterBotId: "coordinator",
    workerBotId: "worker",
    approvalBoundaries: { scopes: ["ordinary"], connectors: [] },
    snapshot: {
      pin: {
        runtimeKind: "pi",
        provider: "fixture",
        modelId: "fixture",
        effort: "off",
        credentialId: "fixture",
        revision: 1,
      },
      computer: { id: null, mode: "team", kind: null },
      destination: { host: null, local: true },
    },
    budget: { tokens: 100, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    artifacts: [],
    timeline: [],
    reports: [],
  };
  const tx = {};
  const prisma = {
    run: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "peer-run",
        taskId: "root",
        delegationId: "peer-card",
        spaceId: "space",
        userId: "owner",
        botId: "worker",
        runtimePin: { runtimeKind: "pi" },
      })),
    },
    delegationRoot: { findUnique: vi.fn(async () => null) },
    delegation: { findUniqueOrThrow: vi.fn(async () => ({ card })) },
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  expect(await checkDelegationExecution(prisma, "peer-run", "shell")).toContain("read-only");
  expect(updateWorkerTask).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      runId: "peer-run",
      executionId: "peer-block:peer-run",
      tool: "report_progress",
      args: expect.objectContaining({ state: "blocked" }),
    }),
  );
});
