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
          modelId: "changed-current-pin",
          thread: { id: "thread", nextEventSeq: 2 },
        },
        { id: "chief", name: "Chief", thread: null },
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
    message: {
      findMany: vi.fn(() => {
        throw new Error("Narration must never be read");
      }),
    },
  };
  return { db, prisma: db as unknown as PrismaClient, delegation, run };
}
describe("team.board", () => {
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
    expect(result.rows[0].usage).toEqual({ tokens: 150, costs: [] });
    expect(result.rows[0].sentence).not.toContain("narration");
    if (run !== "queued") expect(result.rows[0].executing?.pin.modelId).toBe("executed-model");
    else expect(result.rows[0].executing).toBeNull();
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
