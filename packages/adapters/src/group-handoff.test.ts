import { delegationProblem } from "@ardurbot/contracts";
import { DelegationAdmissionError } from "@ardurbot/db";
import type * as DelegationModule from "./delegation.js";
import { prepareDelegation } from "./delegation.js";

vi.mock("./delegation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof DelegationModule>()),
  prepareDelegation: vi.fn(async () => ({
    ok: true,
    record: { id: "delegation", differences: [] },
    runData: { delegationId: "delegation" },
  })),
}));

import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { handoffToGroupBot } from "./group-handoff.js";

const run = {
  id: "run-a",
  spaceId: "workspace-1",
  threadId: "thread-1",
  botId: "bot-a",
  userId: "user-1",
};

function harness(
  sourceBlocks: unknown,
  existing?: { sourceRuns: { id: string; botId: string }[] },
  goal = false,
) {
  const runCreate = vi.fn(async () => ({ id: "run-b" }));
  const messageCreate = vi.fn(async () => ({ id: "message-1" }));
  const tx = {
    delegation: { update: vi.fn(async () => ({})) },
    $queryRaw: vi.fn(async () => [{ id: "group-1" }]),
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group-1",
        coordinatorBotId: "bot-a",
        members: ["bot-a", "bot-b", "bot-c"].map((id) => ({
          bot: { id, name: id.toUpperCase() },
        })),
      })),
      update: vi.fn(async () => ({ id: "group-1" })),
    },
    run: {
      findFirst: vi.fn(async () => ({
        id: run.id,
        goalId: goal ? "goal-1" : null,
        sourceMessage: { blocks: sourceBlocks },
      })),
      findUnique: vi.fn(async () => ({ status: "running" })),
      create: runCreate,
    },
    message: {
      findUnique: vi.fn(
        async (_input: { where: { threadId_clientNonce: { clientNonce: string } } }) =>
          existing ?? null,
      ),
      create: messageCreate,
    },
    thread: {
      update: vi.fn(async (args: { select: { nextMessageSeq?: boolean } }) =>
        args.select.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 2 },
      ),
    },
    task: { create: vi.fn(async () => ({ id: "task-b" })) },
    teamGoal: {
      findFirst: vi.fn(async () =>
        goal
          ? {
              id: "goal-1",
              perWorkerTokens: 30_000,
              untilAt: new Date("2030-01-01T00:00:00Z"),
            }
          : null,
      ),
    },
    event: {
      findMany: vi.fn(async () => [{ seq: 1, payload: { botId: "bot-b" } }]),
      create: vi.fn(async () => ({ seq: 1 })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  return {
    deps: {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    },
    messageCreate,
    messageFindUnique: tx.message.findUnique,
    eventFindMany: tx.event.findMany,
    runCreate,
  };
}

describe("group handoff ownership", () => {
  it("marks a new ownership transfer as a follow-up with a chain hop", async () => {
    const { deps, messageCreate, runCreate } = harness([{ kind: "text", text: "user request" }]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Do the distinct next stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });

    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              kind: "handoff",
              fromBotId: "bot-a",
              toBotId: "bot-b",
              hop: 1,
            }),
          ],
        }),
      }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "follow_up" }) }),
    );
  });

  it("refuses to bounce a handed-off stage straight back to its sender", async () => {
    const { deps, runCreate } = harness([
      { kind: "handoff", fromBotId: "bot-b", toBotId: "bot-a", text: "Investigate", hop: 1 },
    ]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "You investigate it",
      }),
    ).resolves.toEqual({
      error:
        "do not hand this stage back to its sender; post the result in the shared thread instead",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("caps longer multi-agent handoff chains", async () => {
    const { deps, runCreate } = harness([
      { kind: "handoff", fromBotId: "bot-b", toBotId: "bot-a", text: "Stage six", hop: 6 },
    ]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "Stage seven",
      }),
    ).resolves.toEqual({
      error:
        "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("reuses the recorded transfer when a source run is retried", async () => {
    const { deps, messageCreate, runCreate } = harness([], {
      sourceRuns: [{ id: "run-b", botId: "bot-b" }],
    });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "A duplicate stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b", runId: "run-b" });
    expect(messageCreate).not.toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("rejects malformed source ancestry instead of restarting its hop count", async () => {
    const { deps, runCreate } = harness({ kind: "not-an-array" });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Continue",
      }),
    ).resolves.toEqual({ error: "cannot verify the group handoff chain" });
    expect(runCreate).not.toHaveBeenCalled();
  });
});

it("assigns two members with distinct per-target admission keys", async () => {
  const f = harness([], undefined, true);
  const card = { goal: "Review a lane", doneWhen: ["Report the result"] };
  for (const botId of ["bot-b", "bot-c"]) {
    expect(
      await handoffToGroupBot(f.deps as never, run, "group-1", {
        mode: "assign",
        bot_id: botId,
        message: card.goal,
        card,
      }),
    ).toMatchObject({ ok: true, botId });
  }
  expect(
    f.messageFindUnique.mock.calls.map(([input]) => input.where.threadId_clientNonce.clientNonce),
  ).toEqual(["group-handoff:run-a:bot-b", "group-handoff:run-a:bot-c"]);
  expect(f.runCreate).toHaveBeenCalledTimes(2);
  expect(prepareDelegation).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      admissionKey: "group-handoff:run-a:bot-c",
      tokens: 30_000,
      deadlineAt: new Date("2030-01-01T00:00:00Z"),
    }),
    undefined,
  );
});

it("replays the event for the assigned target rather than the latest assignment", async () => {
  const f = harness([], { sourceRuns: [{ id: "run-b", botId: "bot-b" }] }, true);
  f.eventFindMany.mockResolvedValueOnce([
    { seq: 9, payload: { botId: "bot-c" } },
    { seq: 7, payload: { botId: "bot-b" } },
  ]);
  expect(
    await handoffToGroupBot(f.deps as never, run, "group-1", {
      mode: "assign",
      bot_id: "bot-b",
      message: "Review",
      card: { goal: "Review" },
    }),
  ).toMatchObject({ ok: true, botId: "bot-b" });
  expect(f.deps.events.notify).toHaveBeenCalledWith("thread-1", 7);
});

it("returns the shared admission problem without creating a run", async () => {
  const f = harness([]);
  const problem = delegationProblem("budget-exhausted");
  vi.mocked(prepareDelegation).mockRejectedValueOnce(new DelegationAdmissionError(problem));
  expect(
    await handoffToGroupBot(f.deps as never, run, "group-1", {
      bot_id: "bot-b",
      message: "Review",
    }),
  ).toMatchObject({ error: problem.message, problem });
  expect(f.runCreate).not.toHaveBeenCalled();
});

it("passes a task card through the group admission boundary", async () => {
  const f = harness([]);
  const card = { goal: "Check citations", doneWhen: ["Sources agree"], deadlineAt: null };
  await handoffToGroupBot(f.deps as never, run, "group-1", {
    bot_id: "bot-b",
    message: "Check citations",
    card,
  });
  expect(prepareDelegation).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ card, kind: "group-handoff" }),
    undefined,
  );
});
