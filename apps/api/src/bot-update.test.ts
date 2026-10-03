import { describe, expect, it, vi } from "vitest";

vi.mock("@ardurbot/db", async (original) => ({
  ...(await original<object>()),
  appendEventInTransaction: vi.fn(),
}));

import {
  botProfileLabelsChanged,
  commitBotUpdate,
  prepareRuntimeConfigSave,
} from "./bot-update.js";

describe("runtime configuration save precondition", () => {
  const old = {
    runtimeKind: "hermes",
    runtimeConfig: { version: 1, maxProviderRequests: 16, timeoutMs: 180000 },
    modelPinRevision: 4,
  };
  it("treats a default-only version migration as a no-op", () => {
    expect(
      prepareRuntimeConfigSave(
        old,
        {
          runtimeConfig: { version: 2, runtimeKind: "hermes" },
        },
        false,
      ),
    ).toMatchObject({ configChanged: false, incrementRevision: false });
  });
  it("requires and fences the client revision for an execution change", () => {
    const edit = {
      runtimeConfig: {
        version: 2 as const,
        runtimeKind: "hermes" as const,
        limits: { maxProviderRequests: 5 },
      },
    };
    expect(() => prepareRuntimeConfigSave(old, edit, false)).toThrow();
    expect(() =>
      prepareRuntimeConfigSave(old, { ...edit, expectedModelPinRevision: 3 }, false),
    ).toThrow();
    expect(
      prepareRuntimeConfigSave(old, { ...edit, expectedModelPinRevision: 4 }, false),
    ).toMatchObject({ configChanged: true, incrementRevision: true, expectedModelPinRevision: 4 });
    expect(
      prepareRuntimeConfigSave(old, { ...edit, expectedModelPinRevision: 4 }, true),
    ).toMatchObject({ configChanged: true, incrementRevision: false, expectedModelPinRevision: 4 });
  });
  it("preserves dormant settings and rejects a mismatched runtime document", () => {
    expect(
      prepareRuntimeConfigSave(old, { runtimeKind: "pi", expectedModelPinRevision: 4 }, true),
    ).toMatchObject({ configChanged: false });
    expect(() =>
      prepareRuntimeConfigSave(
        old,
        {
          runtimeKind: "pi",
          runtimeConfig: { version: 2, runtimeKind: "hermes" },
          expectedModelPinRevision: 4,
        },
        true,
      ),
    ).toThrow();
  });
});

describe("botProfileLabelsChanged", () => {
  it("is true when name, title, description, or color is present", () => {
    expect(botProfileLabelsChanged({})).toBe(false);
    expect(botProfileLabelsChanged({ name: "SEO" })).toBe(true);
    expect(botProfileLabelsChanged({ title: "Strategist" })).toBe(true);
    expect(botProfileLabelsChanged({ description: "Helps with SEO" })).toBe(true);
    expect(botProfileLabelsChanged({ color: "#8B5CF6::shape_1" })).toBe(true);
  });
});

describe("commitBotUpdate", () => {
  it("writes the bot row and bot.updated in one transaction when labels change", async () => {
    const updated = {
      id: "bot-1",
      name: "SEO Strategist",
      title: "SEO Strategist",
      description: "Helps with keyword research",
    };
    const botUpdate = vi.fn().mockResolvedValue(updated);
    const tx = { bot: { update: botUpdate } };
    const transaction = vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
    const notify = vi.fn().mockResolvedValue(undefined);
    const appendEvent = vi.fn().mockResolvedValue({ seq: 9 });
    const prisma = {
      $transaction: transaction,
      bot: { update: vi.fn() },
    };

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { name: "SEO Strategist", title: "SEO Strategist" },
          emitBotUpdated: true,
        },
        appendEvent,
      ),
    ).resolves.toEqual(updated);

    expect(transaction).toHaveBeenCalledOnce();
    expect(botUpdate).toHaveBeenCalledOnce();
    expect(appendEvent).toHaveBeenCalledWith(tx, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      type: "bot.updated",
      payload: {
        botId: "bot-1",
        name: "SEO Strategist",
        title: "SEO Strategist",
        description: "Helps with keyword research",
      },
    });
    expect(notify).toHaveBeenCalledWith("thread-1", 9);
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it("fails the whole update when the durable event write fails", async () => {
    const appendEvent = vi.fn().mockRejectedValue(new Error("event store unavailable"));
    const transaction = vi.fn(async (run: (client: unknown) => Promise<unknown>) =>
      run({
        bot: {
          update: vi.fn().mockResolvedValue({
            id: "bot-1",
            name: "SEO",
            title: "SEO",
            description: "",
          }),
        },
      }),
    );
    const notify = vi.fn();
    const prisma = {
      $transaction: transaction,
      bot: { update: vi.fn() },
    };

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { name: "SEO" },
          emitBotUpdated: true,
        },
        appendEvent,
      ),
    ).rejects.toThrow("event store unavailable");
    expect(notify).not.toHaveBeenCalled();
    expect(prisma.bot.update).not.toHaveBeenCalled();
  });

  it("updates without an event when profile labels are unchanged", async () => {
    const update = vi.fn().mockResolvedValue({
      id: "bot-1",
      name: "Chief",
      title: "Chief",
      description: "",
    });
    const prisma = {
      $transaction: vi.fn(),
      bot: { update },
    };
    const notify = vi.fn();
    const appendEvent = vi.fn();

    await expect(
      commitBotUpdate(
        {
          prisma: prisma as never,
          notify,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          data: { pinned: true },
          expectedModelPinRevision: 3,
          emitBotUpdated: false,
        },
        appendEvent,
      ),
    ).resolves.toMatchObject({ id: "bot-1" });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "bot-1", modelPinRevision: 3 } }),
    );
  });
});

it.each([false, true])(
  "resets retries after the fenced bot write commits (event: %s)",
  async (emitBotUpdated) => {
    let committed = false;
    const update = vi.fn(async () => ({ id: "bot", name: "Bot", title: "", description: "" }));
    const updateMany = vi.fn(async () => {
      expect(committed).toBe(true);
      return { count: 1 };
    });
    const tx = { bot: { update } };
    const prisma = {
      bot: {
        update: vi.fn(async (args) => {
          const result = await update(args);
          committed = true;
          return result;
        }),
      },
      botBrief: { updateMany },
      $transaction: vi.fn(async (action) => {
        const result = await action(tx);
        committed = true;
        return result;
      }),
    };
    await commitBotUpdate(
      {
        prisma: prisma as never,
        notify: vi.fn(async () => undefined),
        spaceId: "space",
        threadId: "thread",
        botId: "bot",
        emitBotUpdated,
        resetBriefRetries: true,
        expectedModelPinRevision: 2,
        data: { modelPinRevision: { increment: 1 } },
      },
      vi.fn(async () => ({ seq: 1 })) as never,
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bot", modelPinRevision: 2 },
        data: { modelPinRevision: { increment: 1 } },
      }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { botId: "bot" },
      data: { failureCount: 0, nextAttemptAt: null, attemptedAt: null },
    });
  },
);

it("returns the saved bot when retry cleanup fails", async () => {
  const updated = { id: "bot", name: "Bot", title: "", description: "" };
  await expect(
    commitBotUpdate({
      prisma: {
        bot: { update: vi.fn(async () => updated) },
        botBrief: {
          updateMany: vi.fn(async () => {
            throw new Error("reset unavailable");
          }),
        },
      } as never,
      notify: vi.fn(),
      spaceId: "space",
      threadId: "thread",
      botId: "bot",
      emitBotUpdated: false,
      resetBriefRetries: true,
      data: {},
    }),
  ).resolves.toEqual(updated);
});
