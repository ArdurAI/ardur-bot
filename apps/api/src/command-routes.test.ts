import { commandComputerFingerprint } from "@ardurbot/adapters";
import type {
  Actor,
  CommandBlock as FixtureCommandBlock,
  ProductEvent as FixtureProductEvent,
} from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCommandRoutes } from "./command-routes.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "member@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const computer = {
    id: "computer-1",
    scope: "team",
    scopeKey: "team:space-1",
    spaceId: "space-1",
    userId: "other-team-member",
    homeKey: "team-space-1",
    kind: "docker",
    providerRef: "container-1",
  };
  const original = {
    ...commandEvent("command.intent"),
    payload: {
      block: commandBlock(),
      replay: {
        request: { command: "pnpm test", cwd: "/workspace" },
        computerFingerprint: commandComputerFingerprint(
          computer,
          computer.providerRef,
          "/workspace",
        ),
      },
    },
  };
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "completed",
    leaseFence: 1,
    leaseExpiresAt: new Date(Date.now() + 60000),
    attempts: [{ id: "attempt-1", fence: 1 }],
    trigger: "webhook",
    bot: { computer, computerSwitching: false },
  };
  const created: Record<string, unknown>[] = [];
  const prisma = {
    run: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.id === run.id && where.userId === run.userId && where.spaceId === run.spaceId
          ? run
          : null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { ...data, id: `rerun-${created.length}` };
      }),
    },
    computer: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { id: string; spaceId: string; OR: Array<Record<string, string>> };
        }) => {
          const scope = where.OR.some((rule) =>
            Object.entries(rule).every(
              ([key, value]) => computer[key as keyof typeof computer] === value,
            ),
          );
          return computer.id === where.id && computer.spaceId === where.spaceId && scope
            ? computer
            : null;
        },
      ),
    },
    event: { findMany: vi.fn(async () => [original, commandEvent()]) },
    task: { create: vi.fn(async () => ({ id: "new-task" })) },
    $transaction: async (work: (tx: unknown) => unknown) => work(prisma),
  };
  const append = vi.fn(async () => undefined);
  const enqueue = vi.fn(async () => undefined);
  const routes = createCommandRoutes({
    prisma,
    events: { append },
    jobs: { enqueue },
  } as unknown as Parameters<typeof createCommandRoutes>[0]);
  return { routes, computer, created, append, enqueue, prisma, run };
}

describe("command routes", () => {
  it("rechecks user and space when a shared link is opened", async () => {
    const f = fixture();
    const reference = { runId: "run-1", commandId: "command-1" };
    expect((await f.routes.share(actor, reference)).path).toContain("/commands/run-1/command-1");
    await expect(f.routes.open({ ...actor, userId: "user-2" }, reference)).rejects.toThrow();
    await expect(f.routes.open({ ...actor, spaceId: "space-2" }, reference)).rejects.toThrow();
    await expect(f.routes.open(actor, reference)).resolves.toMatchObject({
      commandId: "command-1",
    });
    f.computer.scopeKey = "team:space-2";
    await expect(f.routes.open(actor, reference)).rejects.toThrow();
  });
  it("authorizes Team computers by space and private computers by owner", async () => {
    const f = fixture();
    await expect(f.routes.list(actor, { runId: "run-1" })).resolves.toMatchObject({
      blocks: [expect.anything()],
    });
    f.computer.scope = "dedicated";
    await expect(f.routes.list(actor, { runId: "run-1" })).rejects.toThrow();
  });
  it("audits export and share with actor, time, computer, command and run before returning", async () => {
    const f = fixture();
    const exported = await f.routes.export(actor, { runId: "run-1" });
    expect(exported.text).toContain("exit 0");
    expect(exported.text).toContain("Computer: docker:container-1");
    expect(f.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "command.exported",
        payload: expect.objectContaining({
          actorUserId: "user-1",
          spaceId: "space-1",
          runId: "run-1",
          commandIds: ["command-1"],
          computerIds: ["computer-1"],
          at: expect.any(String),
        }),
      }),
    );
    f.append.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(
      f.routes.share(actor, { runId: "run-1", commandId: "command-1" }),
    ).rejects.toThrow();
  });
  it("searches output and queues exact reruns with fresh identities and original trigger restrictions", async () => {
    const f = fixture();
    expect((await f.routes.list(actor, { runId: "run-1", query: "passed" })).blocks).toHaveLength(
      1,
    );
    expect((await f.routes.list(actor, { runId: "run-1", query: "absent" })).blocks).toHaveLength(
      0,
    );
    const reference = { runId: "run-1", commandId: "command-1" };
    const first = await f.routes.rerun(actor, reference);
    const second = await f.routes.rerun(actor, reference);
    expect(first.runId).not.toBe(second.runId);
    expect(f.created[0]?.clientNonce).not.toBe(f.created[1]?.clientNonce);
    expect(f.created[0]).toMatchObject({ commandReplayId: "command-1", trigger: "webhook" });
    expect(f.enqueue).toHaveBeenCalledTimes(2);
  });
  it("shows superseded and expired attempts as incomplete on authenticated links", async () => {
    const f = fixture();
    f.run.status = "running";
    f.prisma.event.findMany.mockResolvedValueOnce([
      commandEvent("command.intent", { outcome: "running", exitCode: null, durationMs: null }),
    ] as never);
    f.run.leaseFence = 2;
    expect((await f.routes.open(actor, { runId: "run-1", commandId: "command-1" })).outcome).toBe(
      "unknown",
    );
    f.run.leaseFence = 1;
    f.run.leaseExpiresAt = new Date(0);
    f.prisma.event.findMany.mockResolvedValueOnce([
      commandEvent("command.intent", { outcome: "running", exitCode: null, durationMs: null }),
    ] as never);
    expect((await f.routes.open(actor, { runId: "run-1", commandId: "command-1" })).outcome).toBe(
      "unknown",
    );
  });
  it("disables rerun if the computer root changed and queues nothing", async () => {
    const f = fixture();
    f.computer.providerRef = "replacement";
    expect(
      (await f.routes.list(actor, { runId: "run-1" })).blocks[0]?.rerunDisabledReason,
    ).toContain("changed");
    await expect(f.routes.rerun(actor, { runId: "run-1", commandId: "command-1" })).rejects.toThrow(
      "changed",
    );
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.created).toEqual([]);
  });
  it("disables rerun while the computer is switching", async () => {
    const f = fixture();
    f.run.bot.computerSwitching = true;
    const input = { runId: "run-1", commandId: "command-1" };
    expect((await f.routes.open(actor, input)).rerunDisabledReason).toContain("changing");
    await expect(f.routes.rerun(actor, input)).rejects.toThrow("changing");
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});

function commandBlock(overrides: Partial<FixtureCommandBlock> = {}): FixtureCommandBlock {
  return {
    commandId: "command-1",
    runId: "run-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    command: "pnpm test",
    cwd: "/workspace",
    computerId: "computer-1",
    computer: "docker:container-1",
    startedAt: "2026-09-23T12:00:00.000Z",
    durationMs: 12000,
    exitCode: 0,
    outcome: "completed",
    stdout: "Tests passed.\n",
    stderr: "",
    error: null,
    redacted: false,
    truncated: false,
    replayOf: null,
    rerunDisabledReason: null,
    ...overrides,
  };
}

function commandEvent(
  type: FixtureProductEvent["type"] = "command.finished",
  overrides: Partial<FixtureCommandBlock> = {},
): FixtureProductEvent {
  return {
    id: type,
    seq: type === "command.intent" ? 1 : type === "command.started" ? 2 : 3,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    runId: "run-1",
    createdAt: "2026-09-23T12:00:00.000Z",
    type,
    payload: { block: commandBlock(overrides) },
  };
}
