import type { Actor, TaskCard } from "@ardurbot/contracts";
import { TaskCardSchema, TeamBoardSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { acceptTeamTask, teamBoard, teamState } from "./team.js";

const actor: Actor = {
  spaceId: "space",
  userId: "owner",
  email: "fixture@example.test",
  isDeploymentOwner: false,
};
const snapshot: TaskCard["snapshot"] = {
  pin: {
    runtimeKind: "pi",
    provider: "executed-provider",
    modelId: "executed-model",
    effort: "high",
    credentialId: "connection",
    revision: 1,
  },
  computer: { id: "computer", kind: "test", mode: "team" },
  destination: { host: "localhost", local: true },
};
const card = TaskCardSchema.parse({
  goal: "Review sources",
  doneWhen: [],
  requesterBotId: "chief",
  workerBotId: "worker",
  approvalBoundaries: { scopes: ["ordinary"], connectors: [] },
  snapshot,
  budget: { tokens: 10000, deadlineAt: "2026-09-26T18:00:00.000Z" },
  artifacts: [],
  timeline: [],
});
function fixture(runStatus = "running", delegationStatus = "running") {
  const delegation = {
    id: "handoff",
    ...actor,
    requesterBotId: "chief",
    actingBotId: "worker",
    requesterName: "Chief",
    actingName: "Reviewer",
    kind: "message",
    rootTaskId: "root",
    parentRunId: "parent",
    runId: "run",
    depth: 1,
    hop: 1,
    status: delegationStatus,
    result: null as string | null,
    snapshot,
    card,
    authority: card.approvalBoundaries,
    differences: [],
    reservedTokens: 10000,
    deadlineAt: new Date(card.budget.deadlineAt),
    createdAt: new Date(),
    completedAt: null,
    acceptedAt: null,
  };
  const run = {
    id: "run",
    ...actor,
    botId: "worker",
    taskId: "task",
    delegationRootTaskId: "root",
    delegationId: "handoff",
    status: runStatus,
    createdAt: new Date(),
    startedAt: runStatus === "queued" ? null : new Date(),
    completedAt: null,
    leaseExpiresAt: ["leased", "running"].includes(runStatus)
      ? new Date(Date.now() + 60_000)
      : null,
    runtimePin: snapshot.pin,
    runtimeComputer: snapshot.computer,
    runtimeDestination: snapshot.destination,
    prompt: "Ignore this narration: I am finished",
  };
  const scoped = (values: unknown[]) =>
    vi.fn(async ({ where }) => {
      expect(where.spaceId).toBe("space");
      expect(where.userId).toBe("owner");
      return values;
    });
  const db = {
    spaceMember: { findUnique: vi.fn(async () => ({ role: "member" }) as unknown) },
    bot: {
      findMany: scoped([
        {
          id: "worker",
          name: "Reviewer",
          title: "Reviewer",
          description: "",
          concurrentRuns: null,
          groupMembers: [],
          modelId: "changed-current-pin",
          thread: { id: "thread", nextEventSeq: 2 },
        },
        {
          id: "chief",
          name: "Chief",
          title: "Chief",
          description: "",
          concurrentRuns: null,
          groupMembers: [],
          thread: null,
        },
      ]),
    },
    run: { findMany: scoped([run]) },
    delegation: { findMany: scoped([delegation]), findFirstOrThrow: vi.fn() },
    delegationRoot: {
      findMany: scoped([{ rootTaskId: "root", coordinatorBotId: "chief", activeDescendants: 1 }]),
    },
    externalEffect: {
      findMany: vi.fn(async ({ where }) => {
        expect(where.spaceId).toBe("space");
        expect(where.runId.in).toEqual(["run"]);
        return runStatus === "waiting_input" ? [{ runId: "run" }] : [];
      }),
    },
    usageRecord: {
      findMany: scoped([
        {
          runId: "run",
          delegationId: "handoff",
          inputTokens: 100,
          outputTokens: 50,
          cost: null,
          pricingProvenance: null,
        },
      ]),
    },
    event: { findMany: vi.fn(async () => []) },
    botMessageDelivery: { findMany: scoped([]), groupBy: scoped([]) },
    botCommunicationPolicy: { findMany: scoped([]) },
    botBrief: { findMany: scoped([]) },
    teamGoal: { findMany: scoped([]) },
    task: { findMany: scoped([]) },
    connection: { findMany: scoped([]) },
    message: { findMany: vi.fn() },
    $queryRaw: vi.fn(async () => []),
  };
  return { db, prisma: db as unknown as PrismaClient, delegation, run };
}
describe("team.board", () => {
  it("projects the run's effort evidence without changing its saved pin", async () => {
    const f = fixture();
    const runtimeInfo = {
      runtimeKind: "claude-code",
      effortAttested: false,
      effortAttestationReason: "Claude Code does not report the applied effort",
    };
    Object.assign(f.run, { runtimeInfo });
    const row = TeamBoardSchema.parse(await teamBoard(f.prisma, actor)).rows[0]!;
    expect(row.executing).toMatchObject({ pin: snapshot.pin, runtimeInfo });
  });
  it.each([
    ["queued", "queued", "queued"],
    ["running", "running", "working"],
    ["waiting_input", "running", "waiting-approval"],
    ["failed", "failed", "blocked"],
    ["completed", "completed", "completed"],
    ["completed", "accepted", "accepted"],
  ])("projects %s / %s from records", async (run, delegation, state) => {
    const f = fixture(run, delegation);
    const result = TeamBoardSchema.parse(await teamBoard(f.prisma, actor));
    expect(result.rows[0].state).toBe(state);
    expect(result.rows[1].state).toBe("idle");
    expect(f.db.message.findMany).not.toHaveBeenCalled();
    expect(f.db.$queryRaw).toHaveBeenCalledOnce();
    expect(result.rows[0].usage).toEqual({ tokens: 150, partial: false, costs: [] });
    expect(result.rows[0].sentence).not.toContain("narration");
    if (run !== "queued") expect(result.rows[0].executing?.pin.modelId).toBe("executed-model");
    else expect(result.rows[0].executing).toBeNull();
  });

  it.each(["failed", "cancelled"])(
    "keeps a %s handoff record listed after its run ends",
    async (status) => {
      const f = fixture("cancelled", status);
      const result = TeamBoardSchema.parse(await teamBoard(f.prisma, actor));
      expect(f.db.delegation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                status: { in: expect.arrayContaining(["failed", "cancelled"]) },
              }),
            ]),
          }),
        }),
      );
      expect(result.rows[0]!.delegations.map((row) => row.status)).toContain(status);
    },
  );

  it("bounds terminal handoff records by time without bounding active ones", async () => {
    const f = fixture();
    await teamBoard(f.prisma, actor);
    expect(f.db.delegation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { status: { in: ["queued", "running", "cancel-requested"] } },
            {
              status: { in: ["completed", "failed", "cancelled"] },
              createdAt: { gte: expect.any(Date) },
            },
          ],
        }),
      }),
    );
  });

  it("shows the handoff's recorded reason when a blocked card has no runtime problem", async () => {
    // The owner stopped the worker mid-turn; the runtime reported its usage limit while
    // unwinding, the run ended cancelled and no run.failed event exists. The recorded
    // handoff reason is the card's reason, not a generic line.
    const f = fixture("cancelled", "failed");
    f.delegation.result = "Claude Code's usage limit is reached. Try again after it resets.";
    const row = TeamBoardSchema.parse(await teamBoard(f.prisma, actor)).rows[0]!;
    expect(row.state).toBe("blocked");
    expect(row.reason).toBe("Claude Code's usage limit is reached. Try again after it resets.");
    expect(row.reasonCategory).toBe("usage-limit");
    expect(row.reasonRuntime).toBe("Claude Code");
  });

  it("shows a recorded provider failure reason a plain handoff carries", async () => {
    // A pi provider failure carries no runtimeProblem; the redacted reason recorded on
    // the handoff is still the honest card text.
    const f = fixture("failed", "failed");
    f.delegation.result = "rate limit reached; retry later";
    const row = TeamBoardSchema.parse(await teamBoard(f.prisma, actor)).rows[0]!;
    expect(row.state).toBe("blocked");
    expect(row.reason).toBe("rate limit reached; retry later");
    expect(row.reasonCategory).toBeUndefined();
  });

  it("stops showing a failed handoff as blocked once the bot has newer work", async () => {
    const f = fixture("completed", "failed");
    f.delegation.result = "Claude Code's usage limit is reached. Try again after it resets.";
    f.delegation.createdAt = new Date("2026-09-28T10:00:00.000Z");
    Object.assign(f.run, {
      delegationId: null,
      createdAt: new Date("2026-09-28T12:00:00.000Z"),
    });
    const row = TeamBoardSchema.parse(await teamBoard(f.prisma, actor)).rows[0]!;
    expect(row.state).toBe("idle");
    expect(row.reason).toBeNull();
  });

  it("keeps a failed handoff blocked when the bot's latest run is older than it", async () => {
    const f = fixture("completed", "failed");
    f.delegation.result = "Claude Code's usage limit is reached. Try again after it resets.";
    f.delegation.createdAt = new Date("2026-09-28T12:00:00.000Z");
    Object.assign(f.run, {
      delegationId: null,
      createdAt: new Date("2026-09-28T10:00:00.000Z"),
    });
    const row = TeamBoardSchema.parse(await teamBoard(f.prisma, actor)).rows[0]!;
    expect(row.state).toBe("blocked");
    expect(row.reason).toBe("Claude Code's usage limit is reached. Try again after it resets.");
  });

  it("keeps unavailable usage off the card instead of showing zero", async () => {
    const f = fixture();
    f.db.usageRecord.findMany.mockResolvedValue([
      {
        runId: "run",
        delegationId: "handoff",
        inputTokens: 0,
        outputTokens: 0,
        cost: null,
        pricingProvenance: null,
        categoryCoverage: { logicalInput: "unknown", output: "unknown" },
      },
    ]);
    expect(TeamBoardSchema.parse(await teamBoard(f.prisma, actor)).rows[0]!.usage).toEqual({
      tokens: null,
      partial: false,
      costs: [],
    });
  });
  it("marks a partial measurement as a lower bound", async () => {
    const f = fixture();
    f.db.usageRecord.findMany.mockResolvedValue([
      {
        runId: "run",
        delegationId: "handoff",
        inputTokens: 100,
        outputTokens: 40,
        cost: null,
        pricingProvenance: null,
        categoryCoverage: { logicalInput: "complete", output: "partial" },
      },
    ]);
    expect(TeamBoardSchema.parse(await teamBoard(f.prisma, actor)).rows[0]!.usage).toEqual({
      tokens: 140,
      partial: true,
      costs: [],
    });
  });
  it("shows a started run that never reported usage as unavailable, not zero", async () => {
    const f = fixture();
    f.db.usageRecord.findMany.mockResolvedValue([]);
    expect(TeamBoardSchema.parse(await teamBoard(f.prisma, actor)).rows[0]!.usage).toEqual({
      tokens: null,
      partial: false,
      costs: [],
    });
  });
  it("keeps zero for a run that never started", async () => {
    const f = fixture("queued", "queued");
    f.db.usageRecord.findMany.mockResolvedValue([]);
    expect(TeamBoardSchema.parse(await teamBoard(f.prisma, actor)).rows[0]!.usage).toEqual({
      tokens: 0,
      partial: false,
      costs: [],
    });
  });
  it("shows saved blocker reasons and actions", async () => {
    const f = fixture();
    f.delegation.card = {
      ...card,
      timeline: [
        {
          id: "blocked",
          kind: "blocked",
          text: "Source unavailable",
          action: "Choose a source",
          at: "2026-09-25T10:00:00.000Z",
        },
      ],
    };
    expect((await teamBoard(f.prisma, actor)).rows[0]).toMatchObject({
      state: "blocked",
      reason: "Source unavailable",
      action: "Choose a source",
    });
  });
  it.each(["error", "failed"])("shows a %s computer as blocked", async (computerState) => {
    const f = fixture("completed", "completed");
    Object.assign(f.db, {
      hostRegistration: { findUnique: vi.fn(async () => ({ platform: "linux" })) },
    });
    const bots = await f.db.bot.findMany({ where: { spaceId: "space", userId: "owner" } });
    f.db.bot.findMany.mockResolvedValue([
      { ...bots[0], computer: { id: "computer", kind: "docker", state: computerState } },
      bots[1],
    ]);
    expect((await teamBoard(f.prisma, actor)).rows[0]).toMatchObject({
      state: "blocked",
      reason: "The task needs attention",
    });
  });
  it("names each computer by its connection, else by the engine of its kind", async () => {
    const f = fixture();
    const bots = [
      ["e2b", null],
      ["docker", null],
      ["desktop", null],
      ["remote-docker", "office"],
    ].map(([kind, connectionId], index) => ({
      id: `bot-${index}`,
      name: `Bot ${index}`,
      title: "",
      description: "",
      concurrentRuns: null,
      groupMembers: [],
      thread: null,
      computer: { kind, connectionId },
    }));
    f.db.bot.findMany.mockResolvedValue(bots);
    Object.assign(f.db, {
      connection: { findMany: vi.fn(async () => [{ id: "office", displayName: "Office" }]) },
      hostRegistration: { findUnique: vi.fn(async () => ({ platform: "linux" })) },
    });
    const { rows, hostLabel } = await teamBoard(f.prisma, actor);
    expect(rows.map((row) => row.computerName)).toEqual([
      "E2B",
      "Docker on this computer",
      "This computer",
      "Office",
    ]);
    expect(rows.map((row) => row.computerBuiltin)).toEqual([null, "local-docker", "host", null]);
    expect(hostLabel).toBe("This computer");
  });
  it("rejects non-members before reading any records or accepting a task", async () => {
    const f = fixture();
    f.db.spaceMember.findUnique.mockResolvedValue(null);
    await expect(teamBoard(f.prisma, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(acceptTeamTask(f.prisma, actor, "foreign-handoff")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(f.db.bot.findMany).not.toHaveBeenCalled();
    expect(f.db.delegation.findFirstOrThrow).not.toHaveBeenCalled();
  });
  it("does not infer an approval from a worker's status text", () => {
    expect(teamState({ runStatus: "running", approval: false })).toBe("working");
    expect(teamState({ runStatus: "waiting_input", approval: false })).toBe("blocked");
  });
});
