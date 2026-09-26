import type { Actor } from "@ardurbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createRepos } from "./repos.js";
import { IsolationError } from "./scope.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "ws-1",
  email: "test@example.com",
  isDeploymentOwner: false,
};

const baseBot = {
  id: "bot-1",
  spaceId: "ws-1",
  userId: "user-1",
  name: "Test Bot",
  title: "",
  description: "",
  instructions: "",
  color: "#000",
  notifyOnFinish: true,
  pinned: false,
  position: 0,
  sectionId: null,
  archivedAt: null,
  parentBotId: null,
  memoryScope: null as string | null,
  createdAt: new Date("2026-08-19T00:00:00.000Z"),
  updatedAt: new Date("2026-08-19T00:00:00.000Z"),
  thread: { id: "thread-1", unread: false, messages: [] },
  runs: [],
  computer: null,
};

describe("createRepos.createBot model pins", () => {
  it.each(["child", "duplicate"])(
    "preserves the complete %s pin in storage and the DTO",
    async (kind) => {
      const pin = {
        modelProvider: "openai-compatible",
        modelId: "same-model",
        thinkingLevel: "high",
        modelCredentialId: "exact-endpoint",
        modelPinRevision: 4,
      };
      let stored = { ...baseBot, ...pin };
      const tx = {
        $queryRaw: vi.fn(async () => []),
        spaceMember: {
          findUnique: vi.fn(async () => ({ organizationId: "org", space: { deletingAt: null } })),
        },
        computer: { upsert: vi.fn(async () => ({ id: "computer" })) },
        bot: {
          aggregate: vi.fn(async () => ({ _max: { position: 0 } })),
          create: vi.fn(async ({ data }: { data: typeof pin }) => {
            stored = { ...baseBot, ...data };
            return stored;
          }),
          findFirstOrThrow: vi.fn(async () => stored),
        },
        thread: { create: vi.fn(async () => baseBot.thread) },
        browserProfile: { create: vi.fn(async () => ({})) },
        memoryDocument: { create: vi.fn(async () => ({})) },
      };
      const prisma = {
        bot: { findFirst: vi.fn(async () => ({ ...baseBot, ...pin })) },
        deploymentSettings: { findUnique: vi.fn(async () => null) },
        $transaction: vi.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx)),
      };
      const result = await createRepos(prisma as unknown as PrismaClient).createBot(actor, {
        name: "Copy",
        title: "",
        description: "",
        instructions: "",
        color: baseBot.color,
        notifyOnFinish: false,
        ...(kind === "child" ? { parentBotId: baseBot.id } : pin),
      });
      expect(stored).toMatchObject(pin);
      expect(result).toMatchObject(pin);
    },
  );
});

function reposFor(memoryScope: string | null) {
  const prisma = {
    bot: {
      findMany: vi.fn(async () => [{ ...baseBot, memoryScope }]),
    },
    run: {
      findMany: vi.fn(async () => []),
    },
  };
  return createRepos(prisma as unknown as PrismaClient);
}

describe("createRepos.listBots", () => {
  it("passes memoryScope through as null when unset", async () => {
    await expect(reposFor(null).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ memoryScope: null }),
    ]);
  });

  it("passes memoryScope through when set to shared", async () => {
    await expect(reposFor("shared").listBots(actor)).resolves.toEqual([
      expect.objectContaining({ memoryScope: "shared" }),
    ]);
  });

  it("classifies initial preview runs once across bots, including non-peer results", async () => {
    const prisma = {
      bot: {
        findMany: vi.fn(async () =>
          ["one", "two"].map((id) => ({
            ...baseBot,
            id,
            thread: {
              ...baseBot.thread,
              id: `thread-${id}`,
              messages: [{ runId: `run-${id}`, blocks: [{ kind: "text", text: `Answer ${id}` }] }],
            },
          })),
        ),
      },
      run: { findMany: vi.fn(async () => []) },
    };

    const bots = await createRepos(prisma as unknown as PrismaClient).listBots(actor);

    expect(bots.map((bot) => bot.preview)).toEqual(["Answer one", "Answer two"]);
    expect(prisma.run.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: ["run-one", "run-two"] }, trigger: "bot_message" },
      select: { id: true },
    });
  });

  it("classifies unseen runs in older pages and retains negative results between pages", async () => {
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          {
            ...baseBot,
            thread: {
              ...baseBot.thread,
              messages: [
                { seq: 30, runId: "peer-new", blocks: [{ kind: "text", text: "Hidden" }] },
              ],
            },
          },
        ]),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: "peer-new" }])
          .mockResolvedValueOnce([{ id: "peer-old" }]),
      },
      message: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { seq: 20, runId: "peer-old", blocks: [{ kind: "text", text: "Also hidden" }] },
            { seq: 19, runId: "user-old", blocks: [] },
          ])
          .mockResolvedValueOnce([
            { seq: 10, runId: "peer-old", blocks: [{ kind: "text", text: "Still hidden" }] },
            { seq: 9, runId: "user-old", blocks: [{ kind: "text", text: "Visible answer" }] },
          ]),
      },
    };

    const bots = await createRepos(prisma as unknown as PrismaClient).listBots(actor);

    expect(bots[0]?.preview).toBe("Visible answer");
    expect(prisma.run.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.run.findMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ["peer-old", "user-old"] }, trigger: "bot_message" },
      select: { id: true },
    });
    expect(prisma.message.findMany).toHaveBeenCalledTimes(2);
  });

  it("keeps bot-to-bot run output out of sidebar previews", async () => {
    const findMany = vi.fn(async () => [
      {
        ...baseBot,
        thread: {
          ...baseBot.thread,
          messages: [
            {
              runId: "run-peer",
              blocks: [{ kind: "text", text: "Echoed peer reply" }],
            },
            {
              runId: "run-peer",
              blocks: [
                {
                  kind: "bot_message_received",
                  fromBotId: "bot-2",
                  fromBotName: "Coder",
                  text: "Peer result",
                },
              ],
            },
            { runId: "run-user", blocks: [{ kind: "text", text: "Visible answer" }] },
          ],
        },
      },
    ]);
    const prisma = {
      bot: {
        findMany,
      },
      run: {
        findMany: vi.fn(async () => [{ id: "run-peer" }]),
      },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Visible answer" }),
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          thread: {
            include: {
              messages: { orderBy: { seq: "desc" }, take: 16 },
            },
          },
        }),
      }),
    );
  });

  it("skips a peer-run preview tail when the receipt is outside the window", async () => {
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          {
            ...baseBot,
            thread: {
              ...baseBot.thread,
              messages: [
                {
                  runId: "run-peer",
                  blocks: [{ kind: "text", text: "Echoed peer reply" }],
                },
                { runId: "run-user", blocks: [{ kind: "text", text: "Visible answer" }] },
              ],
            },
          },
        ]),
      },
      run: {
        findMany: vi.fn(async () => [{ id: "run-peer" }]),
      },
      message: {
        findMany: vi.fn(async () => []),
      },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Visible answer" }),
    ]);
  });

  it("scans older messages when the newest window is only peer output", async () => {
    const messageFindMany = vi.fn(async () => [
      { seq: 1, runId: "run-user", blocks: [{ kind: "text", text: "Older visible answer" }] },
    ]);
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          {
            ...baseBot,
            thread: {
              ...baseBot.thread,
              messages: [
                {
                  seq: 20,
                  runId: "run-peer",
                  blocks: [{ kind: "text", text: "Echoed peer reply" }],
                },
              ],
            },
          },
        ]),
      },
      run: {
        findMany: vi.fn(async () => [{ id: "run-peer" }]),
      },
      message: {
        findMany: messageFindMany,
      },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Older visible answer" }),
    ]);
    expect(messageFindMany).toHaveBeenCalledWith({
      where: { threadId: "thread-1", seq: { lt: 20 } },
      orderBy: { seq: "desc" },
      take: 16,
    });
  });

  it("uses a visible message from the fourth older window for preview", async () => {
    const peerWindows = [
      [{ seq: 80, runId: "run-peer", blocks: [{ kind: "text", text: "peer 80" }] }],
      [{ seq: 60, runId: "run-peer", blocks: [{ kind: "text", text: "peer 60" }] }],
      [{ seq: 40, runId: "run-peer", blocks: [{ kind: "text", text: "peer 40" }] }],
      [{ seq: 20, runId: "run-peer", blocks: [{ kind: "text", text: "peer 20" }] }],
      [{ seq: 1, runId: "run-user", blocks: [{ kind: "text", text: "Fourth-window answer" }] }],
    ];
    let windowIndex = 0;
    const messageFindMany = vi.fn(async () => {
      windowIndex += 1;
      return peerWindows[windowIndex] ?? [];
    });
    const prisma = {
      bot: {
        findMany: vi.fn(async () => [
          {
            ...baseBot,
            thread: {
              ...baseBot.thread,
              messages: peerWindows[0],
            },
          },
        ]),
      },
      run: {
        findMany: vi.fn(async () => [{ id: "run-peer" }]),
      },
      message: {
        findMany: messageFindMany,
      },
    };

    await expect(createRepos(prisma as unknown as PrismaClient).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ preview: "Fourth-window answer" }),
    ]);
    expect(messageFindMany).toHaveBeenCalledTimes(4);
  });
});

describe("createRepos.listSpaceBotsForSpaces", () => {
  it("loads and maps only the compact cross-space sidebar fields", async () => {
    const findMany = vi.fn(async (_query: { where: unknown; select: Record<string, unknown> }) => [
      {
        id: "bot-2",
        spaceId: "ws-2",
        name: "Support",
        title: "Customer support",
        color: "#123456",
        notifyOnFinish: false,
        pinned: true,
        sectionId: null,
        updatedAt: new Date("2026-08-20T00:00:00.000Z"),
        parentBotId: null,
        thread: {
          unread: true,
          messages: [{ blocks: [{ kind: "text", text: "Waiting for a reply" }] }],
        },
        runs: [{ status: "running" }],
      },
    ]);
    const repos = createRepos({ bot: { findMany } } as unknown as PrismaClient);

    await expect(repos.listSpaceBotsForSpaces(actor, ["ws-2"])).resolves.toEqual([
      {
        id: "bot-2",
        spaceId: "ws-2",
        name: "Support",
        title: "Customer support",
        color: "#123456",
        notifyOnFinish: false,
        pinned: true,
        sectionId: null,
        unread: true,
        parentBotId: null,
        preview: "Waiting for a reply",
        status: "running",
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    ]);
    const query = findMany.mock.calls[0]![0];
    expect(query.where).toEqual(
      expect.objectContaining({ spaceId: { in: ["ws-2"] }, userId: actor.userId }),
    );
    expect(query.select).not.toHaveProperty("description");
    expect(query.select).not.toHaveProperty("instructions");
    expect(query.select).not.toHaveProperty("computer");
  });
});

describe("createRepos.reorderBots", () => {
  function reorderRepos(ids: string[]) {
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      bot: {
        findMany: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))),
        update,
      },
    };
    const prisma = {
      $transaction: vi.fn((run: (client: typeof tx) => Promise<void>) => run(tx)),
    };
    return { repos: createRepos(prisma as unknown as PrismaClient), update };
  }

  it("writes each owned bot's requested position", async () => {
    const { repos, update } = reorderRepos(["bot-1", "bot-2"]);
    await repos.reorderBots(actor, ["bot-2", "bot-1"]);
    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: "bot-2" },
      data: { position: 0 },
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { id: "bot-1" },
      data: { position: 1 },
    });
  });

  it("rejects partial or foreign bot lists before writing", async () => {
    const { repos, update } = reorderRepos(["bot-1", "bot-2"]);
    await expect(repos.reorderBots(actor, ["bot-1"])).rejects.toBeInstanceOf(IsolationError);
    await expect(repos.reorderBots(actor, ["bot-1", "foreign"])).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(update).not.toHaveBeenCalled();
  });
});

describe("createRepos.createBot computer kind", () => {
  async function createdKind(computerHost: string | null) {
    const upsert = vi.fn(async (_args: { create: { kind: string } }) => ({ id: "computer" }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      spaceMember: {
        findUnique: vi.fn(async () => ({ organizationId: "org", space: { deletingAt: null } })),
      },
      computer: { upsert },
      bot: {
        aggregate: vi.fn(async () => ({ _max: { position: 0 } })),
        create: vi.fn(async () => baseBot),
        findFirstOrThrow: vi.fn(async () => baseBot),
      },
      thread: { create: vi.fn(async () => baseBot.thread) },
      browserProfile: { create: vi.fn(async () => ({})) },
      memoryDocument: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      deploymentSettings: { findUnique: vi.fn(async () => ({ computerHost })) },
      $transaction: vi.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    await createRepos(prisma as unknown as PrismaClient).createBot(actor, {
      name: "New",
      title: "",
      description: "",
      instructions: "",
      color: baseBot.color,
      notifyOnFinish: false,
    });
    return upsert.mock.calls[0]?.[0].create.kind;
  }

  afterEach(() => vi.unstubAllEnvs());

  it("starts a new computer on this computer in the desktop app's local mode", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "desktop");
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
    expect(await createdKind(null)).toBe("desktop");
  });

  // Set up saves this-mac on the desktop app's own stack; until then new computers stay on Docker.
  it.each([
    [null, "docker"],
    ["this-mac", "desktop"],
    ["docker", "docker"],
  ])(
    "on the desktop app's own Compose stack, with the host choice %s, starts a new computer on %s",
    async (computerHost, kind) => {
      vi.stubEnv("SANDBOX_PROVIDER", "docker");
      vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
      vi.stubEnv("ARDURBOT_DESKTOP_STACK", "1");
      expect(await createdKind(computerHost)).toBe(kind);
    },
  );

  it.each(["api", ""])(
    "keeps Docker the default on a server (host bridge %j) until the owner chooses the host",
    async (bridge) => {
      vi.stubEnv("SANDBOX_PROVIDER", "docker");
      vi.stubEnv("ARDURBOT_HOST_BRIDGE", bridge);
      vi.stubEnv("ARDURBOT_DESKTOP_STACK", "");
      expect(await createdKind(null)).toBe("docker");
      expect(await createdKind("this-mac")).toBe("desktop");
    },
  );
});
