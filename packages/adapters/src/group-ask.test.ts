import { delegationProblem } from "@ardurbot/contracts";
import type * as Database from "@ardurbot/db";
import { DelegationAdmissionError } from "@ardurbot/db";
import type * as DelegationModule from "./delegation.js";
import { delegationFloorForModel, prepareDelegation } from "./delegation.js";

vi.mock("./delegation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof DelegationModule>()),
  prepareDelegation: vi.fn(),
}));
vi.mock("@ardurbot/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  sizeDelegationRootForAsk: vi.fn(async () => ({})),
  wakeCoordinatorForGroupAsk: vi.fn(async () => ({ runId: "wake-run", threadId: "room" })),
  loadGroupAskResults: vi.fn(async () => ({
    userRequest: "tell the bots to introduce each other, do not mention individually",
    results: [
      {
        id: "ada",
        name: "Ada",
        request: "Introduce yourself",
        outcome: "answered",
        text: "Hi",
        posted: false,
      },
    ],
  })),
}));

import type { PrismaClient } from "@ardurbot/db";
import { loadGroupAskResults, sizeDelegationRootForAsk } from "@ardurbot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { askGroupMembers, loadAskWakeContext, wakeCoordinatorAfterAsk } from "./group-ask.js";

const run = {
  id: "chief-run",
  spaceId: "space",
  threadId: "room",
  botId: "chief",
  userId: "owner",
  clientNonce: "send:message-1:chief",
};
const members = [
  { id: "chief", name: "Chief" },
  { id: "ada", name: "Ada" },
  { id: "ben", name: "Ben" },
  { id: "cy", name: "Cy" },
];

/** A resolved pin on a standard model the registry does not know: the standard floor. */
const resolvedPin = {
  kind: "resolved" as const,
  pin: {
    runtimeKind: "pi" as const,
    provider: "test",
    modelId: "standard",
    effort: "high" as const,
    credentialId: "connection",
    revision: 0,
  },
  reasoning: false,
};
const reasoningPin = {
  ...resolvedPin,
  pin: { ...resolvedPin.pin, modelId: "reasoning" },
  reasoning: true,
};
// Expectations derive from the same floor admission enforces, not from literals.
const memberFloor = delegationFloorForModel(resolvedPin.pin, resolvedPin);
const reasoningFloor = delegationFloorForModel(reasoningPin.pin, reasoningPin);

function harness(
  options: {
    coordinatorBotId?: string;
    paused?: boolean;
    existingMessage?: boolean;
    asked?: Array<{ actingBotId: string; actingName: string }>;
    resolveDelegationPin?: (bot: { id: string }) => Promise<unknown>;
  } = {},
) {
  let seq = 0;
  const runCreate = vi.fn(async ({ data }: { data: { botId: string } }) => ({
    id: `run-${data.botId}`,
    ...data,
  }));
  const taskCreate = vi.fn(async ({ data }: { data: { botId: string } }) => ({
    id: `task-${data.botId}`,
    ...data,
  }));
  const messageCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "ask-message",
    ...data,
  }));
  const eventCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data,
    seq: seq++,
  }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "group" }]),
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group",
        coordinatorBotId: options.coordinatorBotId ?? "chief",
        members: members.map((bot) => ({ bot })),
      })),
      update: vi.fn(async () => ({})),
    },
    botCommunicationPolicy: {
      findMany: vi.fn(async () => (options.paused ? [{ paused: true, enabled: true }] : [])),
    },
    run: {
      findFirst: vi.fn(async () => ({ id: run.id })),
      findUnique: vi.fn(async () => ({ status: "running" })),
      create: runCreate,
    },
    bot: {
      findFirstOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const bot = members.find((member) => member.id === where.id);
        if (!bot) throw new Error("not found");
        return { ...bot, computerId: "computer", computer: null };
      }),
    },
    message: {
      findUnique: vi.fn(async () => (options.existingMessage ? { id: "ask-message" } : null)),
      create: messageCreate,
    },
    delegation: {
      findMany: vi.fn(async () => options.asked ?? []),
      update: vi.fn(async () => ({})),
    },
    task: { create: taskCreate },
    thread: {
      update: vi.fn(async (args: { select: { nextMessageSeq?: boolean } }) =>
        args.select.nextMessageSeq ? { nextMessageSeq: 3 } : { nextEventSeq: seq + 1 },
      ),
    },
    event: { create: eventCreate },
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    events: { notify: vi.fn(async () => undefined) },
    jobs: { enqueue: vi.fn(async () => undefined) },
    resolveDelegationPin: options.resolveDelegationPin ?? (async () => resolvedPin),
  };
  return { deps, tx, runCreate, taskCreate, messageCreate, eventCreate };
}

const admitted = (actingBotId: string) => ({
  ok: true as const,
  record: { id: `delegation-${actingBotId}` },
  runData: { delegationId: `delegation-${actingBotId}`, delegationRootTaskId: "root" },
});

beforeEach(() => {
  vi.mocked(prepareDelegation).mockReset();
  vi.mocked(prepareDelegation).mockImplementation(
    async (_tx, input) => admitted(input.actingBotId) as never,
  );
  vi.mocked(sizeDelegationRootForAsk).mockClear();
});

describe("ask_members fan-out", () => {
  it("asks every other member exactly once when the request needs everyone", async () => {
    const h = harness();
    const result = await askGroupMembers(h.deps as never, run, "group", {
      members: ["all", "Ada", "everyone"],
      request: "Introduce yourself to the room in two sentences.",
      callId: "call-1",
    });

    expect(result).toMatchObject({
      ok: true,
      asked: [
        { botId: "ada", name: "Ada" },
        { botId: "ben", name: "Ben" },
        { botId: "cy", name: "Cy" },
      ],
      notAsked: [],
    });
    expect(prepareDelegation).toHaveBeenCalledTimes(3);
    expect(vi.mocked(prepareDelegation).mock.calls.map(([, input]) => input)).toEqual(
      ["ada", "ben", "cy"].map((id) =>
        expect.objectContaining({
          actingBotId: id,
          kind: "group-handoff",
          parentRunId: run.id,
          admissionKey: `group-ask:1:chief-run:call-1:${id}`,
          tokens: memberFloor,
          targetThreadId: "room",
        }),
      ),
    );
    expect(sizeDelegationRootForAsk).toHaveBeenCalledWith(expect.anything(), {
      runId: run.id,
      memberTokens: [memberFloor, memberFloor, memberFloor],
    });
    expect(h.messageCreate).toHaveBeenCalledOnce();
    expect(h.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        role: "bot",
        botId: "chief",
        blocks: [
          { kind: "text", text: "@Ada @Ben @Cy Introduce yourself to the room in two sentences." },
        ],
        clientNonce: "group-ask:1:chief-run:call-1",
      }),
    });
    expect(h.runCreate).toHaveBeenCalledTimes(3);
    for (const [call] of h.runCreate.mock.calls)
      expect(call.data).toMatchObject({
        trigger: "follow_up",
        status: "queued",
        threadId: "room",
        sourceMessageId: "ask-message",
        delegationRootTaskId: "root",
      });
    expect(h.taskCreate.mock.calls[0]?.[0].data).toMatchObject({
      botId: "ada",
      prompt: expect.stringContaining("Chief (id: chief) coordinates this group chat"),
    });
    const audits = h.eventCreate.mock.calls
      .map(([call]) => call.data)
      .filter((event) => event.type === "group.handoff");
    expect(audits.map((event) => event.payload)).toEqual(
      ["ada", "ben", "cy"].map((id) =>
        expect.objectContaining({ fromBotId: "chief", toBotId: id, mode: "ask" }),
      ),
    );
    expect(h.deps.jobs.enqueue).toHaveBeenCalledTimes(3);
  });

  it("reserves each member's own floor, larger for a reasoning model, and sizes the room to the sum", async () => {
    const h = harness({
      resolveDelegationPin: async (bot) => (bot.id === "ben" ? reasoningPin : resolvedPin),
    });
    const result = await askGroupMembers(h.deps as never, run, "group", {
      members: ["all"],
      request: "What are you working on?",
      callId: "call-1",
    });

    expect(result).toMatchObject({
      ok: true,
      asked: [
        { botId: "ada", name: "Ada" },
        { botId: "ben", name: "Ben" },
        { botId: "cy", name: "Cy" },
      ],
      notAsked: [],
    });
    expect(
      vi.mocked(prepareDelegation).mock.calls.map(([, input]) => [input.actingBotId, input.tokens]),
    ).toEqual([
      ["ada", memberFloor],
      ["ben", reasoningFloor],
      ["cy", memberFloor],
    ]);
    expect(reasoningFloor).toBeGreaterThan(memberFloor);
    expect(sizeDelegationRootForAsk).toHaveBeenCalledWith(expect.anything(), {
      runId: run.id,
      memberTokens: [memberFloor, reasoningFloor, memberFloor],
    });
  });

  it("asks the rest when one member's budget refuses, and reports that member", async () => {
    vi.mocked(prepareDelegation).mockImplementation(async (_tx, input) => {
      if (input.actingBotId === "ben")
        throw new DelegationAdmissionError(delegationProblem("budget-exhausted"));
      if (input.actingBotId === "cy")
        return { ok: false, error: "Reconnect Cy's model.", problem: {} } as never;
      return admitted(input.actingBotId) as never;
    });
    const h = harness();
    const result = await askGroupMembers(h.deps as never, run, "group", {
      members: ["all"],
      request: "What are you working on?",
      callId: "call-1",
    });

    expect(result).toMatchObject({
      ok: true,
      asked: [{ botId: "ada", name: "Ada" }],
      notAsked: [
        {
          member: "Ben",
          reason: "This task has no remaining worker budget; start a new task to continue.",
        },
        { member: "Cy", reason: "Reconnect Cy's model." },
      ],
    });
    expect(h.runCreate).toHaveBeenCalledOnce();
    expect(h.messageCreate.mock.calls[0]?.[0].data.blocks).toEqual([
      { kind: "text", text: "@Ada What are you working on?" },
    ]);
  });

  it("starts nobody when every member is refused", async () => {
    vi.mocked(prepareDelegation).mockRejectedValue(
      new DelegationAdmissionError(delegationProblem("descendants-exceeded")),
    );
    const h = harness();
    const result = await askGroupMembers(h.deps as never, run, "group", {
      members: ["Ada"],
      request: "Status?",
      callId: "call-1",
    });
    expect(result).toMatchObject({ error: "No member could be asked." });
    expect(h.messageCreate).not.toHaveBeenCalled();
    expect(h.runCreate).not.toHaveBeenCalled();
    expect(h.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("is only for the coordinator, respects a paused room and stops after the follow-up round", async () => {
    const notCoordinator = harness({ coordinatorBotId: "ada" });
    await expect(
      askGroupMembers(notCoordinator.deps as never, run, "group", {
        members: ["Ben"],
        request: "Hi",
        callId: "call-1",
      }),
    ).resolves.toEqual({ error: "ask_members is only for this group's coordinator" });

    const paused = harness({ paused: true });
    await expect(
      askGroupMembers(paused.deps as never, run, "group", {
        members: ["Ben"],
        request: "Hi",
        callId: "call-1",
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining("Team messages are paused") });

    const followUp = harness();
    await expect(
      askGroupMembers(
        followUp.deps as never,
        { ...run, clientNonce: "ask-wake:2:earlier-run" },
        "group",
        { members: ["Ben"], request: "Hi", callId: "call-1" },
      ),
    ).resolves.toMatchObject({ error: expect.stringContaining("already asked the room") });
    for (const h of [notCoordinator, paused, followUp]) expect(h.runCreate).not.toHaveBeenCalled();
    expect(followUp.deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(prepareDelegation).not.toHaveBeenCalled();
  });

  it("replays a retried call without starting anyone twice", async () => {
    const h = harness({
      existingMessage: true,
      asked: [{ actingBotId: "ada", actingName: "Ada" }],
    });
    await expect(
      askGroupMembers(h.deps as never, run, "group", {
        members: ["Ada"],
        request: "Hi",
        callId: "call-1",
      }),
    ).resolves.toMatchObject({ ok: true, replayed: true, asked: [{ botId: "ada", name: "Ada" }] });
    expect(prepareDelegation).not.toHaveBeenCalled();
    expect(h.runCreate).not.toHaveBeenCalled();
    expect(h.deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("does not ask a member twice in one turn and names unknown members", async () => {
    const h = harness({ asked: [{ actingBotId: "ada", actingName: "Ada" }] });
    const result = await askGroupMembers(h.deps as never, run, "group", {
      members: ["Ada", "Ben", "Zed"],
      request: "One more thing",
      callId: "call-2",
    });
    expect(result).toMatchObject({
      ok: true,
      asked: [{ botId: "ben", name: "Ben" }],
      notAsked: [
        { member: "Zed", reason: "not a current member of this room" },
        { member: "Ada", reason: "already asked in this turn" },
      ],
    });
    expect(prepareDelegation).toHaveBeenCalledOnce();
  });

  it("validates members and request before touching the room", async () => {
    const h = harness();
    await expect(
      askGroupMembers(h.deps as never, run, "group", { members: [], request: "Hi", callId: "c" }),
    ).resolves.toMatchObject({ error: expect.stringContaining("members is required") });
    await expect(
      askGroupMembers(h.deps as never, run, "group", {
        members: ["all"],
        request: " ",
        callId: "c",
      }),
    ).resolves.toEqual({ error: "request is required" });
    expect(h.deps.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("ask_members fan-in", () => {
  it("gives the coordinator's follow-up turn every result, reading only its own scope", async () => {
    const prisma = {} as PrismaClient;
    // The executor passes its whole run row; only the scope may reach the database.
    const run = {
      id: "wake-run",
      spaceId: "space",
      userId: "owner",
      status: "running",
      runtimePin: { modelId: "model" },
      clientNonce: "ask-wake:1:chief-run",
    };
    const context = await loadAskWakeContext(prisma, run);
    expect(loadGroupAskResults).toHaveBeenCalledWith(
      prisma,
      { spaceId: "space", userId: "owner" },
      { round: 1, askRunId: "chief-run" },
    );
    expect(context).toContain("<ask_results>");
    expect(context).toContain("<user_request>");
    expect(context).toContain("tell the bots to introduce each other, do not mention individually");
    expect(context).toContain('- Ada (id: ada), asked "Introduce yourself", answered: Hi');
    vi.mocked(loadGroupAskResults).mockClear();
    await expect(
      loadAskWakeContext(prisma, { ...run, clientNonce: "send:message:chief" }),
    ).resolves.toBeUndefined();
    expect(loadGroupAskResults).not.toHaveBeenCalled();
  });

  it("queues the coordinator's follow-up turn once the last member settles", async () => {
    const jobs = { enqueue: vi.fn(async () => undefined) };
    await wakeCoordinatorAfterAsk({ prisma: {} as PrismaClient, jobs } as never, "delegation-ada");
    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    await wakeCoordinatorAfterAsk({ prisma: {} as PrismaClient, jobs } as never, null);
    expect(jobs.enqueue).toHaveBeenCalledOnce();
  });
});
