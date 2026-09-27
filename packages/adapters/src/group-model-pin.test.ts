import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { captureRunModelPin, selectRunPinSource } from "./group-model-pin.js";

const pin = {
  runtimeKind: "pi" as const,
  provider: "scripted",
  modelId: "scripted",
  effort: "off",
  credentialId: "scripted",
  revision: 2,
};
const scope = { userId: "owner", spaceId: "space" };
const bot = {
  modelProvider: "scripted",
  modelId: "scripted",
  thinkingLevel: "off",
  modelCredentialId: "scripted",
  modelPinRevision: 3,
};

function selectionFixture(groupId: string | null = "group", memberPin: unknown = pin) {
  const thread = vi.fn(async () => ({ groupId }));
  const group = vi.fn(async () => ({
    members: [
      {
        id: "member",
        modelPinRevision: memberPin ? 2 : 0,
        runtimePin: memberPin,
      },
    ],
  }));
  const prisma = {
    thread: { findFirst: thread },
    chatGroup: { findFirst: group },
  } as unknown as PrismaClient;
  return { prisma, thread, group };
}

describe("group run pin selection", () => {
  it.each(["human", "mention", "reply", "routine", "goal-wake"])(
    "%s room execution uses the acting membership",
    async () => {
      const f = selectionFixture();
      const selected = await selectRunPinSource({
        prisma: f.prisma,
        scope,
        threadId: "room",
        botId: "bot",
        bot,
        snapshot: null,
        savedSource: null,
        savedUsageGroupId: null,
      });
      expect(selected).toMatchObject({
        snapshot: pin,
        usageGroupId: "group",
        source: { kind: "group-member", groupId: "group", memberId: "member", botId: "bot" },
      });
      expect(f.group).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: "owner",
            spaceId: "space",
            archivedAt: null,
          }),
        }),
      );
    },
  );

  it("uses the second group's own membership, not the bot pin", async () => {
    const f = selectionFixture("other-group", { ...pin, modelId: "other" });
    await expect(
      selectRunPinSource({
        prisma: f.prisma,
        scope,
        threadId: "other-room",
        botId: "bot",
        bot,
        snapshot: null,
        savedSource: null,
        savedUsageGroupId: null,
      }),
    ).resolves.toMatchObject({
      snapshot: { modelId: "other" },
      source: { groupId: "other-group" },
    });
  });

  it.each(["desk", "dm"])("%s uses the bot's normal pin", async () => {
    const f = selectionFixture(null);
    const selected = await selectRunPinSource({
      prisma: f.prisma,
      scope,
      threadId: "solo",
      botId: "bot",
      bot,
      snapshot: null,
      savedSource: null,
      savedUsageGroupId: null,
    });
    expect(selected).toMatchObject({ snapshot: null, source: { kind: "bot" }, usageGroupId: null });
    expect(f.group).not.toHaveBeenCalled();
  });

  it("keeps an admitted helper or running snapshot without a membership lookup", async () => {
    const f = selectionFixture();
    const selected = await selectRunPinSource({
      prisma: f.prisma,
      scope,
      threadId: "room",
      botId: "bot",
      bot,
      snapshot: { ...pin, revision: 1 },
      savedSource: { kind: "group-member", groupId: "old", memberId: "old-member", botId: "bot" },
      savedUsageGroupId: "old",
    });
    expect(selected).toMatchObject({ snapshot: { revision: 1 }, usageGroupId: "old" });
    expect(f.thread).not.toHaveBeenCalled();
  });

  it("ignores a room override for a comparison run", async () => {
    const f = selectionFixture();
    const selected = await selectRunPinSource({
      prisma: f.prisma,
      scope,
      threadId: "room",
      botId: "bot",
      bot,
      snapshot: null,
      savedSource: null,
      savedUsageGroupId: null,
      comparisonId: "comparison",
    });
    expect(selected.source.kind).toBe("bot");
    expect(f.thread).not.toHaveBeenCalled();
  });

  it("fails a removed member without using the bot pin", async () => {
    const f = selectionFixture();
    f.group.mockResolvedValueOnce({ members: [] } as never);
    await expect(
      selectRunPinSource({
        prisma: f.prisma,
        scope,
        threadId: "room",
        botId: "bot",
        bot,
        snapshot: null,
        savedSource: null,
        savedUsageGroupId: null,
      }),
    ).rejects.toThrow("The bot is no longer a member");
  });
});

describe("fenced run pin capture", () => {
  function fixture(revision = 2, updated = 1) {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: updated })
      .mockResolvedValue({ count: 1 });
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "group" }]),
      chatGroup: { findFirst: vi.fn(async () => ({ thread: { id: "room" } })) },
      chatGroupMember: {
        findUnique: vi.fn(async () => ({
          id: "member",
          groupId: "group",
          botId: "bot",
          modelPinRevision: revision,
          runtimePin: pin,
        })),
      },
      run: {
        updateMany,
        findUnique: vi.fn(async (query: { select: { threadId?: boolean } }) =>
          query.select.threadId
            ? { threadId: "room" }
            : {
                status: "running",
                leaseOwner: "worker",
                leaseFence: 7,
                runtimePin: pin,
                runtimePinSource: {
                  kind: "group-member",
                  groupId: "group",
                  memberId: "member",
                  botId: "bot",
                },
                usageGroupId: "group",
              },
        ),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;
    const candidate = {
      snapshot: pin,
      source: { kind: "group-member" as const, groupId: "group", memberId: "member", botId: "bot" },
      usageGroupId: "group",
      membership: { groupId: "group", memberId: "member", revision: 2, pin },
    };
    return { prisma, tx, updateMany, candidate };
  }

  it("writes once under the lease fence and re-reads the committed winner", async () => {
    const f = fixture();
    expect(
      await captureRunModelPin({
        prisma: f.prisma,
        scope,
        runId: "run",
        workerId: "worker",
        fence: 7,
        candidate: f.candidate,
        pin,
      }),
    ).toMatchObject({ pin, usageGroupId: "group" });
    expect(f.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "running",
          leaseOwner: "worker",
          leaseFence: 7,
          runtimePin: expect.any(Object),
        }),
        data: expect.objectContaining({ runtimePin: pin, usageGroupId: "group" }),
      }),
    );
  });

  it("reselects a stale member before a write", async () => {
    const f = fixture(3);
    expect(
      await captureRunModelPin({
        prisma: f.prisma,
        scope,
        runId: "run",
        workerId: "worker",
        fence: 7,
        candidate: f.candidate,
        pin,
      }),
    ).toBe("stale");
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it("uses an existing committed pin after losing the null-pin compare", async () => {
    const f = fixture(2, 0);
    expect(
      await captureRunModelPin({
        prisma: f.prisma,
        scope,
        runId: "run",
        workerId: "worker",
        fence: 7,
        candidate: f.candidate,
        pin,
      }),
    ).toMatchObject({ pin });
  });

  it("fills delegated run model columns from its pre-set committed pin under the lease", async () => {
    const f = fixture(2, 0);
    const candidate = {
      ...f.candidate,
      membership: null,
      source: { kind: "bot" as const, botId: "bot" },
    };
    await captureRunModelPin({
      prisma: f.prisma,
      scope,
      runId: "delegated",
      workerId: "worker",
      fence: 7,
      candidate,
      pin: { ...pin, modelId: "new-choice" },
    });
    expect(f.updateMany).toHaveBeenLastCalledWith({
      where: { id: "delegated", status: "running", leaseOwner: "worker", leaseFence: 7 },
      data: { modelProvider: pin.provider, modelId: pin.modelId },
    });
  });
});
