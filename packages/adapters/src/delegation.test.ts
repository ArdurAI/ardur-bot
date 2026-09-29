import type * as Database from "@ardurbot/db";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { admitDelegation, requestCancel, updateWorkerTask } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { prepareDelegation } from "./delegation.js";
import { checkDelegationExecution } from "./delegation-execution.js";
import { piModelLimits } from "./pi-models.js";

vi.mock("@ardurbot/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  admitDelegation: vi.fn(async (_tx, input) => ({
    id: "handoff",
    rootTaskId: "root",
    snapshot: input.snapshot,
    differences: [],
  })),
  requestCancel: vi.fn(async () => ({ cancelRequested: true })),
  updateWorkerTask: vi.fn(async () => ({ ok: true })),
  reconcileGoalExhaustion: vi.fn(async () => undefined),
}));
vi.mock("./pi-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pi-models.js")>()),
  piModelLimits: vi.fn(() => ({})),
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
  vi.mocked(piModelLimits).mockReturnValue({ contextWindow: 8_192 });
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
  vi.mocked(piModelLimits).mockReturnValue({});
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
it("derives the floor from the effective output cap, including reasoning and connection limits", async () => {
  const pin = {
    provider: "scripted",
    modelId: "scripted",
    effort: "off",
    credentialId: "scripted",
    revision: 4,
    runtimeKind: "pi" as const,
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
  // A reasoning model bills thinking against its output ceiling: 8192 + 32768.
  vi.mocked(piModelLimits).mockReturnValue({ contextWindow: 8_192, reasoning: true });
  await prepareDelegation(tx, {
    parentRunId: "parent",
    actingBotId: "bot",
    actingName: "Helper",
    spaceId: "space",
    userId: "owner",
    kind: "helper",
    admissionKey: "helper-floor-reasoning",
    prompt: "Review",
  });
  expect(admitDelegation).toHaveBeenLastCalledWith(
    tx,
    expect.objectContaining({ minimumTokens: 40_960 }),
  );
  // A connection-configured output cap on the parent run's resolved model raises the floor
  // of inherited pins too: 8192 + 65536.
  vi.mocked(piModelLimits).mockReturnValue({ contextWindow: 8_192 });
  await prepareDelegation(tx, {
    parentRunId: "parent",
    actingBotId: "bot",
    actingName: "Helper",
    spaceId: "space",
    userId: "owner",
    kind: "helper",
    admissionKey: "helper-floor-configured",
    prompt: "Review",
    workerLimits: { maxTokens: 65_536 },
  });
  expect(admitDelegation).toHaveBeenLastCalledWith(
    tx,
    expect.objectContaining({ minimumTokens: 73_728 }),
  );
  // A resolved worker's own connection limits apply to non-inherited admissions.
  vi.mocked(piModelLimits).mockReturnValue({ contextWindow: 200_000, maxTokens: 128_000 });
  const resolve = vi.fn(async () => ({
    kind: "resolved" as const,
    pin,
    runtimePin: pin,
    provider: "scripted",
    id: "scripted",
    thinkingLevel: "high" as const,
    maxTokens: 16_384,
    contextWindow: 100_000,
  }));
  await prepareDelegation(
    tx,
    {
      parentRunId: "parent",
      actingBotId: "bot",
      actingName: "Worker",
      spaceId: "space",
      userId: "owner",
      kind: "message",
      admissionKey: "message-floor",
      prompt: "Review",
    },
    resolve,
  );
  // The resolved connection's context window and output cap win: 32768 (capped) + 16384.
  expect(admitDelegation).toHaveBeenLastCalledWith(
    tx,
    expect.objectContaining({ minimumTokens: 49_152 }),
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
function stoppingPrisma(row: {
  status: string;
  deadlineAt: Date;
  usedTokens: number;
  reservedTokens: number;
}) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const delegationUpdateMany = vi.fn(async () => ({ count: 1 }));
  const delegation = { id: "handoff", ...row };
  const prisma = {
    run: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "run",
        taskId: "task",
        delegationId: "handoff",
        spaceId: "space",
        userId: "owner",
      })),
      updateMany,
    },
    delegationRoot: { findUnique: vi.fn(async () => null) },
    delegation: {
      findUniqueOrThrow: vi.fn(async () => delegation),
      updateMany: delegationUpdateMany,
    },
  } as unknown as PrismaClient;
  return { prisma, updateMany, delegationUpdateMany };
}
it("names the token budget when a worker is stopped for overspending it", async () => {
  // The evidence row: a 10000 reservation against a first request that used 16734.
  const { prisma, updateMany, delegationUpdateMany } = stoppingPrisma({
    status: "running",
    deadlineAt: new Date(Date.now() + 60_000),
    usedTokens: 16_734,
    reservedTokens: 10_000,
  });
  const denied = await checkDelegationExecution(prisma, "run", "shell");
  expect(denied).toContain("token budget");
  expect(denied).not.toContain("or is stopping");
  expect(updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ cancelRequestedAt: expect.any(Date) }),
    }),
  );
  // The gate records why it stopped the worker while the cause is still known.
  expect(delegationUpdateMany).toHaveBeenCalledWith({
    where: { id: "handoff", cancelReason: null },
    data: { cancelReason: "budget" },
  });
});
it("names the deadline when a worker is stopped past its deadline", async () => {
  const { prisma, delegationUpdateMany } = stoppingPrisma({
    status: "running",
    deadlineAt: new Date(Date.now() - 1_000),
    usedTokens: 0,
    reservedTokens: 36_864,
  });
  expect(await checkDelegationExecution(prisma, "run", "shell")).toContain("deadline");
  expect(delegationUpdateMany).toHaveBeenCalledWith({
    where: { id: "handoff", cancelReason: null },
    data: { cancelReason: "deadline" },
  });
});
it("records deadline or budget when the task itself is stopping", async () => {
  const run = {
    id: "run",
    taskId: "task",
    delegationRootTaskId: "root",
    delegationId: "handoff",
    spaceId: "space",
    userId: "owner",
    goalId: null as string | null,
  };
  const root = {
    cancelRequestedAt: null as Date | null,
    deadlineAt: new Date(Date.now() - 1_000),
    usedTokens: 0,
    tokenLimit: 120_000,
  };
  const prisma = {
    run: { findUniqueOrThrow: vi.fn(async () => run) },
    delegationRoot: { findUnique: vi.fn(async () => root) },
    delegation: { findFirst: vi.fn(async () => null) },
    botMessageWake: { findFirst: vi.fn(async () => null) },
  } as unknown as PrismaClient;
  expect(await checkDelegationExecution(prisma, "run")).toContain("stopping");
  expect(requestCancel).toHaveBeenCalledWith(
    prisma,
    { spaceId: "space", userId: "owner" },
    "root",
    expect.any(Date),
    "deadline",
  );
  vi.mocked(requestCancel).mockClear();
  // A goal budget still stops the tree, and the recorded cause is the budget.
  // Outside a goal, the same overspend leaves admitted workers running; that case is separate.
  root.deadlineAt = new Date(Date.now() + 60_000);
  root.usedTokens = 120_000;
  run.goalId = "goal";
  expect(await checkDelegationExecution(prisma, "run")).toContain("stopping");
  expect(requestCancel).toHaveBeenCalledWith(
    prisma,
    { spaceId: "space", userId: "owner" },
    "root",
    expect.any(Date),
    "budget",
  );
  vi.mocked(requestCancel).mockClear();
  root.cancelRequestedAt = new Date();
  expect(await checkDelegationExecution(prisma, "run")).toContain("stopping");
  expect(requestCancel).not.toHaveBeenCalled();
});
it("names the stop when a worker is already stopping", async () => {
  const { prisma, delegationUpdateMany } = stoppingPrisma({
    status: "cancel-requested",
    deadlineAt: new Date(Date.now() + 60_000),
    usedTokens: 0,
    reservedTokens: 36_864,
  });
  expect(await checkDelegationExecution(prisma, "run", "shell")).toContain("stopping");
  // An already-stopping worker keeps the cause recorded when the stop was requested.
  expect(delegationUpdateMany).not.toHaveBeenCalled();
});

it("stops a member asked by its room coordinator once the owner pauses team messages", async () => {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const paused = vi.fn(async () => [{ paused: true, enabled: true }]);
  const prisma = {
    run: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "run",
        taskId: "task",
        threadId: "room",
        spaceId: "space",
        userId: "owner",
        delegationId: "ask",
      })),
      updateMany,
    },
    delegationRoot: { findUnique: vi.fn(async () => null) },
    delegation: {
      findUniqueOrThrow: vi.fn(async () => ({
        admissionKey: "group-ask:1:coordinator-run:call:run-bot",
        status: "running",
        deadlineAt: new Date(Date.now() + 60_000),
        usedTokens: 0,
        reservedTokens: 100,
      })),
    },
    thread: { findUnique: vi.fn(async () => ({ groupId: "group" })) },
    botCommunicationPolicy: { findMany: paused },
  } as unknown as PrismaClient;
  expect(await checkDelegationExecution(prisma, "run")).toBe("Team messages are paused.");
  expect(updateMany).toHaveBeenCalledWith({
    where: { id: "run", cancelRequestedAt: null },
    data: { cancelRequestedAt: expect.any(Date) },
  });
  paused.mockResolvedValue([]);
  expect(await checkDelegationExecution(prisma, "run")).toBeUndefined();
});

it("keeps workers admitted before their coordinator's turn pushed the task over its token budget", async () => {
  vi.mocked(requestCancel).mockClear();
  // A native coordinator reports its whole turn's usage as the turn ends; its room workers can
  // only start after that, and must not be stopped by it.
  const overspent = {
    rootTaskId: "root",
    usedTokens: 200_000,
    tokenLimit: 120_000,
    cancelRequestedAt: null,
    deadlineAt: new Date(Date.now() + 60_000),
  };
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = (run: Record<string, unknown>) =>
    ({
      run: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "run",
          taskId: "task",
          threadId: "room",
          spaceId: "space",
          userId: "owner",
          goalId: null,
          delegationRootTaskId: "root",
          ...run,
        })),
        updateMany,
      },
      delegationRoot: { findUnique: vi.fn(async () => overspent) },
      botMessageWake: { findFirst: vi.fn(async () => null) },
      delegation: {
        findFirst: vi.fn(async () => null),
        findUniqueOrThrow: vi.fn(async () => ({
          admissionKey: "group-handoff:coordinator-run",
          status: "queued",
          deadlineAt: new Date(Date.now() + 60_000),
          usedTokens: 0,
          reservedTokens: 10_000,
        })),
      },
    }) as unknown as PrismaClient;
  expect(
    await checkDelegationExecution(prisma({ delegationId: "handoff" }), "run"),
  ).toBeUndefined();
  // The coordinator's own turn is not stopped either; admission refuses anything new.
  expect(
    await checkDelegationExecution(prisma({ delegationRootTaskId: null, taskId: "root" }), "run"),
  ).toBeUndefined();
  expect(requestCancel).not.toHaveBeenCalled();
  expect(updateMany).not.toHaveBeenCalled();
  // A goal's budget is the owner's cap for the whole tree.
  expect(
    await checkDelegationExecution(prisma({ delegationId: "handoff", goalId: "goal" }), "run"),
  ).toBe("This task is stopping; start a new task to continue.");
  expect(requestCancel).toHaveBeenCalledOnce();
  // A stopped task or a passed deadline still stops every worker.
  vi.mocked(requestCancel).mockClear();
  overspent.deadlineAt = new Date(Date.now() - 1);
  expect(await checkDelegationExecution(prisma({ delegationId: "handoff" }), "run")).toBe(
    "This task is stopping; start a new task to continue.",
  );
  expect(requestCancel).toHaveBeenCalledOnce();
});
it("stops a worker over its reservation before its next step, not after its turn has ended", async () => {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const row = {
    id: "ask",
    admissionKey: "group-ask:1:coordinator-run:call:member",
    status: "running",
    deadlineAt: new Date(Date.now() + 60_000),
    // A native member reports its whole turn's usage just before it finishes.
    usedTokens: 45_000,
    reservedTokens: 30_000,
    authority: { scopes: ["ordinary"], connectors: [] },
  };
  const delegationUpdateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    run: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "run",
        taskId: "task",
        threadId: "room",
        spaceId: "space",
        userId: "owner",
        goalId: null,
        delegationId: "ask",
        delegationRootTaskId: "root",
      })),
      updateMany,
    },
    delegationRoot: { findUnique: vi.fn(async () => null) },
    delegation: { findUniqueOrThrow: vi.fn(async () => row), updateMany: delegationUpdateMany },
    thread: { findUnique: vi.fn(async () => ({ groupId: "group" })) },
    botCommunicationPolicy: { findMany: vi.fn(async () => []) },
    remoteAuthorityPolicy: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaClient;
  expect(
    await checkDelegationExecution(prisma, "run", undefined, undefined, undefined, {
      reservation: false,
    }),
  ).toBeUndefined();
  expect(updateMany).not.toHaveBeenCalled();
  expect(delegationUpdateMany).not.toHaveBeenCalled();
  expect(await checkDelegationExecution(prisma, "run", "read_file")).toBe(
    "This worker used its token budget. Raise the budget and try again.",
  );
  expect(updateMany).toHaveBeenCalledOnce();
  expect(delegationUpdateMany).toHaveBeenCalledWith({
    where: { id: "ask", cancelReason: null },
    data: { cancelReason: "budget" },
  });
  row.deadlineAt = new Date(Date.now() - 1);
  expect(
    await checkDelegationExecution(prisma, "run", undefined, undefined, undefined, {
      reservation: false,
    }),
  ).toBe("This worker reached its deadline. Start a new task to continue.");
});
