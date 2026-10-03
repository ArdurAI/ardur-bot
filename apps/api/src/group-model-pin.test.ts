import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { updateGroupMemberModelPin } from "./group-model-pin.js";
import type { RouterDeps } from "./router.js";

vi.mock("@ardurbot/adapters", async (original) => ({
  ...(await original<object>()),
  nativeHostOwner: vi.fn(async () => true),
}));
vi.mock("./model-pin-validation.js", () => ({
  validateModelPinSelection: vi.fn(async (_deps, _actor, pin) => pin),
}));

const actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};
const target = { groupId: "group", botId: "bot", memberId: "member", expectedRevision: 0 };
const choice = {
  runtimeKind: "pi" as const,
  provider: "scripted",
  modelId: "scripted",
  effort: "off",
  credentialId: "scripted",
};

function fixture(
  initialConfig: unknown = null,
  runtimeExperimental = false,
  computer = { kind: "desktop", connectionId: null as string | null },
) {
  let runtimeConfig = initialConfig;
  let botRevision = 1;
  let revision = 0;
  let pin: (typeof choice & { revision: number }) | null = null;
  let memberId = "member";
  const memberRow = () => ({
    id: memberId,
    groupId: "group",
    botId: "bot",
    modelPinRevision: revision,
    runtimePin: pin,
    bot: {
      userId: "owner",
      spaceId: "space",
      archivedAt: null,
      runtimeConfig,
      modelPinRevision: botRevision,
    },
  });
  const groupRecord = () => ({
    id: "group",
    userId: "owner",
    spaceId: "space",
    name: "Group",
    coordinatorBotId: null,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    thread: { id: "room", unread: false, messages: [] },
    members: [
      {
        ...memberRow(),
        bot: {
          id: "bot",
          name: "Bot",
          color: "#111",
          runs: [],
          ...memberRow().bot,
          modelProvider: "scripted",
          modelId: "scripted",
          modelCredentialId: "scripted",
          modelPinRevision: 1,
          thinkingLevel: "off",
          runtimeKind: "pi",
        },
      },
      {
        id: "other-member",
        botId: "other-bot",
        runtimePin: null,
        modelPinRevision: 0,
        bot: { id: "other-bot", name: "Other", color: "#222", runs: [] },
      },
    ],
  });
  const findFirst = vi.fn(
    async (query: {
      include?: unknown;
      select?: unknown;
      where?: { userId?: string; spaceId?: string };
    }) =>
      query.include
        ? groupRecord()
        : query.select && "members" in query.select
          ? {
              members:
                query.where?.userId === "owner" &&
                query.where?.spaceId === "space" &&
                memberId === "member"
                  ? [
                      {
                        id: memberId,
                        bot: { runtimeExperimental, computer },
                      },
                    ]
                  : [],
            }
          : { thread: { id: "room" } },
  );
  const update = vi.fn(
    async ({ data }: { data: { modelPinRevision: number; runtimePin: unknown } }) => {
      revision = data.modelPinRevision;
      pin =
        typeof data.runtimePin === "object" &&
        data.runtimePin !== null &&
        "revision" in data.runtimePin
          ? (data.runtimePin as typeof pin)
          : null;
      return memberRow();
    },
  );
  const eventCreate = vi.fn(async () => ({ seq: 4 }));
  const tx = {
    botBrief: { updateMany: vi.fn(async () => ({ count: 1 })) },
    $queryRaw: vi.fn(async () => [{ id: "group" }]),
    chatGroup: { findFirst, update: vi.fn(async () => groupRecord()) },
    chatGroupMember: { findUnique: vi.fn(async () => memberRow()), update },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 4 })) },
    event: { create: eventCreate },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  const notify = vi.fn(async () => undefined);
  const deps = { prisma, events: { notify } } as unknown as RouterDeps;
  return {
    deps,
    tx,
    notify,
    update,
    eventCreate,
    setMemberId: (id: string) => {
      memberId = id;
    },
    setBotConfig: (value: unknown) => {
      runtimeConfig = value;
      botRevision++;
    },
  };
}

describe("group model owner mutation", () => {
  it.each([null, "docker", "podman", "missing", ""])(
    "admits a host runtime only without connection %s",
    async (connectionId) => {
      const f = fixture(null, true, { kind: "desktop", connectionId });
      const request = updateGroupMemberModelPin(f.deps, actor, target, {
        ...choice,
        runtimeKind: "hermes",
      });
      if (connectionId === null) await expect(request).resolves.toBeDefined();
      else {
        await expect(request).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(f.update).not.toHaveBeenCalled();
      }
    },
  );
  it("snapshots bot-owned Hermes limits with the admitted group connection", async () => {
    const config = { version: 1, maxProviderRequests: 4, timeoutMs: 90_000 };
    const f = fixture(config, true);
    await updateGroupMemberModelPin(f.deps, actor, target, {
      runtimeKind: "hermes",
      provider: "openai-compatible",
      modelId: "fixture-model",
      effort: "off",
      credentialId: "selected",
      runtimeConfig: { version: 1, maxProviderRequests: 64, timeoutMs: 600_000 },
    });
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runtimePin: expect.objectContaining({
            runtimeKind: "hermes",
            credentialId: "selected",
            runtimeConfig: expect.objectContaining({
              version: 2,
              limits: { maxProviderRequests: 4, timeoutMs: 90_000 },
            }),
            runtimeConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
      }),
    );
  });

  it("keeps a captured group setting until an explicit revision-fenced refresh", async () => {
    const f = fixture({ version: 1, maxProviderRequests: 4, timeoutMs: 90_000 }, true);
    const selected = {
      ...choice,
      runtimeKind: "hermes" as const,
      provider: "openai-compatible",
      modelId: "fixture-model",
      credentialId: "selected",
    };
    await updateGroupMemberModelPin(f.deps, actor, target, selected);
    const first = f.update.mock.calls[0]?.[0].data.runtimePin;
    f.setBotConfig({ version: 1, maxProviderRequests: 8, timeoutMs: 90_000 });
    await expect(
      updateGroupMemberModelPin(
        f.deps,
        actor,
        { ...target, expectedRevision: 1, expectedBotModelPinRevision: undefined },
        selected,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      updateGroupMemberModelPin(
        f.deps,
        actor,
        { ...target, expectedRevision: 1, expectedBotModelPinRevision: 1 },
        selected,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.update).toHaveBeenCalledTimes(1);
    await updateGroupMemberModelPin(
      f.deps,
      actor,
      { ...target, expectedRevision: 1, expectedBotModelPinRevision: 2 },
      selected,
    );
    expect(f.update).toHaveBeenCalledTimes(2);
    expect(f.update.mock.calls[1]?.[0].data.runtimePin).toMatchObject({
      runtimeConfig: { limits: { maxProviderRequests: 8, timeoutMs: 90_000 } },
      revision: 2,
    });
    expect(first).toMatchObject({ runtimeConfig: { limits: { maxProviderRequests: 4 } } });
  });

  it("sets once, replays exactly, and clears once with durable events", async () => {
    const f = fixture();
    const first = await updateGroupMemberModelPin(f.deps, actor, target, choice);
    expect(first.members[0]).toMatchObject({
      memberId: "member",
      modelPinRevision: 1,
      runtimePin: { ...choice, revision: 1 },
      effectivePinSource: "group-member",
    });
    expect(f.eventCreate).toHaveBeenCalledTimes(1);
    await updateGroupMemberModelPin(f.deps, actor, target, choice);
    expect(f.eventCreate).toHaveBeenCalledTimes(1);
    const cleared = await updateGroupMemberModelPin(
      f.deps,
      actor,
      { ...target, expectedRevision: 1 },
      null,
    );
    expect(cleared.members[0]).toMatchObject({ runtimePin: null, modelPinRevision: 2 });
    expect(f.eventCreate).toHaveBeenCalledTimes(2);
    expect(f.notify).toHaveBeenCalledTimes(2);
  });

  it("rejects a differing stale revision", async () => {
    const f = fixture();
    await updateGroupMemberModelPin(f.deps, actor, target, choice);
    await expect(
      updateGroupMemberModelPin(f.deps, actor, target, { ...choice, modelId: "different" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.eventCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects replaced members and wrong-space callers before validating a choice", async () => {
    const f = fixture();
    f.setMemberId("replacement");
    await expect(updateGroupMemberModelPin(f.deps, actor, target, choice)).rejects.toThrow();
    await expect(
      updateGroupMemberModelPin(f.deps, { ...actor, spaceId: "other" }, target, choice),
    ).rejects.toThrow();
    await expect(
      updateGroupMemberModelPin(f.deps, { ...actor, userId: "other" }, target, choice),
    ).rejects.toThrow();
    expect(f.update).not.toHaveBeenCalled();
  });
});
