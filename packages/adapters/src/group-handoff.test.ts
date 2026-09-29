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
      findMany: vi.fn(async () => [{ seq: 1, payload: { botId: "bot-b", deliveryKey: "" } }]),
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

  it("refuses a handoff with neither a message nor a card instead of posting empty", async () => {
    const { deps, messageCreate, runCreate } = harness([{ kind: "text", text: "user request" }]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "   ",
      }),
    ).resolves.toEqual({ error: "Give the handoff a message describing the next stage." });
    expect(messageCreate).not.toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("shows the card's goal when a card-carrying handoff leaves the message blank", async () => {
    const { deps, messageCreate } = harness([{ kind: "text", text: "user request" }]);
    vi.mocked(prepareDelegation).mockResolvedValueOnce({
      ok: true,
      record: {
        id: "delegation",
        differences: [],
        card: {
          goal: "Compare the two drafts",
          inputs: [],
          doneWhen: [],
          deadlineAt: null,
          requesterBotId: "bot-a",
          workerBotId: "bot-b",
          approvalBoundaries: { scopes: [], connectors: [] },
          snapshot: {
            pin: {
              runtimeKind: "pi",
              provider: "fixture",
              modelId: "fixture",
              effort: null,
              credentialId: null,
              revision: 1,
            },
            computer: { id: null, mode: "team", kind: null },
            destination: { host: null, local: false },
          },
          budget: { tokens: 36_864, deadlineAt: "2030-01-01T00:00:00.000Z" },
          artifacts: [],
          timeline: [],
          reports: [],
        },
      } as never,
      runData: { delegationId: "delegation" } as never,
    });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "",
        card: { goal: "Compare the two drafts" },
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [expect.objectContaining({ kind: "handoff", text: "Compare the two drafts" })],
        }),
      }),
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
  const keys = f.messageFindUnique.mock.calls.map(
    ([input]) => input.where.threadId_clientNonce.clientNonce,
  );
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^group-handoff:run-a:bot-b:/);
  expect(keys[1]).toMatch(/^group-handoff:run-a:bot-c:/);
  expect(f.runCreate).toHaveBeenCalledTimes(2);
  expect(prepareDelegation).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      admissionKey: keys[1],
      tokens: 30_000,
      deadlineAt: new Date("2030-01-01T00:00:00Z"),
    }),
    undefined,
  );
});

it("admits different cards for one member but replays the same card", async () => {
  const f = harness([], undefined, true);
  f.eventFindMany.mockImplementation(async () => [
    {
      seq: 1,
      payload: {
        botId: "bot-b",
        deliveryKey:
          f.messageFindUnique.mock.lastCall?.[0].where.threadId_clientNonce.clientNonce ?? "",
      },
    },
  ]);
  const saved = new Map<string, { sourceRuns: { id: string; botId: string }[] }>();
  f.messageFindUnique.mockImplementation(
    async ({ where }) => saved.get(where.threadId_clientNonce.clientNonce) ?? null,
  );
  const card = (goal: string) => ({ goal, doneWhen: ["Post findings"] });
  const send = (goal: string) =>
    handoffToGroupBot(f.deps as never, run, "group-1", {
      mode: "assign",
      bot_id: "bot-b",
      message: goal,
      card: card(goal),
    });
  expect(await send("Review API")).toMatchObject({ ok: true });
  const firstKey = f.messageFindUnique.mock.calls[0]![0].where.threadId_clientNonce.clientNonce;
  saved.set(firstKey, { sourceRuns: [{ id: "run-b", botId: "bot-b" }] });
  expect(await send("Review UI")).toMatchObject({ ok: true });
  const secondKey = f.messageFindUnique.mock.calls[1]![0].where.threadId_clientNonce.clientNonce;
  expect(secondKey).not.toBe(firstKey);
  expect(f.runCreate).toHaveBeenCalledTimes(2);
  saved.set(secondKey, { sourceRuns: [{ id: "run-b", botId: "bot-b" }] });
  expect(await send("Review UI")).toMatchObject({ ok: true });
  expect(f.runCreate).toHaveBeenCalledTimes(2);
});

it("uses the earlier card deadline, including an already expired deadline", async () => {
  const f = harness([], undefined, true);
  const early = "2029-12-31T12:00:00.000Z";
  await handoffToGroupBot(f.deps as never, run, "group-1", {
    mode: "assign",
    bot_id: "bot-b",
    message: "Review",
    card: { goal: "Review", deadlineAt: early },
  });
  expect(prepareDelegation).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ deadlineAt: new Date(early) }),
    undefined,
  );
  const expired = "2000-01-01T00:00:00.000Z";
  await handoffToGroupBot(f.deps as never, run, "group-1", {
    mode: "assign",
    bot_id: "bot-b",
    message: "Review old work",
    card: { goal: "Review old work", deadlineAt: expired },
  });
  expect(prepareDelegation).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ deadlineAt: new Date(expired) }),
    undefined,
  );
});

it("replays the event for the assigned target rather than the latest assignment", async () => {
  const f = harness([], { sourceRuns: [{ id: "run-b", botId: "bot-b" }] }, true);
  f.eventFindMany.mockImplementationOnce(async () => [
    { seq: 9, payload: { botId: "bot-c", deliveryKey: "another assignment" } },
    {
      seq: 7,
      payload: {
        botId: "bot-b",
        deliveryKey:
          f.messageFindUnique.mock.lastCall?.[0].where.threadId_clientNonce.clientNonce ?? "",
      },
    },
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
