import type { PrismaClient } from "@ardurbot/db";
import { loadBotPresence } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { loadRoomMemberDirectory, loadRunBotDirectory } from "./bot-presence-directory.js";

vi.mock("@ardurbot/db", () => ({ loadBotPresence: vi.fn() }));

it("selects room members before applying the desk directory page limit", async () => {
  vi.mocked(loadBotPresence).mockResolvedValue({ bots: [], observedAt: new Date().toISOString() });
  await loadRunBotDirectory(
    {} as never,
    { spaceId: "space", userId: "owner" },
    "worker",
    "room",
    true,
  );
  expect(loadBotPresence).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ groupId: "room", visibleGroupId: "room", callerBotId: "worker" }),
  );
  expect(vi.mocked(loadBotPresence).mock.calls[0]?.[2]?.limit).toBeUndefined();
});

const now = new Date("2026-09-28T12:00:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const scope = { spaceId: "space", userId: "owner" };

const run = (patch: Record<string, unknown>) => ({
  threadId: "room",
  createdAt: ago(30),
  startedAt: null,
  completedAt: null,
  leaseExpiresAt: null,
  error: null,
  delegationId: null,
  ...patch,
});

/** Only reads exist: any create, update or delete would throw, so a status answer wakes no one. */
function readOnlyPrisma() {
  const reads = {
    chatGroup: {
      findFirst: vi.fn(async () => ({
        thread: { id: "room" },
        members: [
          {
            bot: {
              id: "chief",
              name: "Chief",
              title: "Coordinator",
              description: "",
              computer: null,
            },
          },
          {
            bot: {
              id: "ada",
              name: "Ada",
              title: "Ops engineer",
              description: "Ships builds.",
              computer: { state: "running" },
            },
          },
          {
            bot: {
              id: "ben",
              name: "Ben",
              title: "Writer",
              description: "Drafts posts.",
              computer: { state: "running" },
            },
          },
          {
            bot: {
              id: "cy",
              name: "Cy",
              title: "Researcher",
              description: "",
              computer: { state: "stopped" },
            },
          },
        ],
      })),
    },
    run: {
      findMany: vi.fn(
        async ({ where }: { where: { status?: { in: string[] }; threadId?: string } }) => {
          if (where.status?.in.includes("queued"))
            return [
              run({
                botId: "ada",
                status: "running",
                startedAt: ago(4),
                leaseExpiresAt: new Date(now.getTime() + 60_000),
                taskId: "task-deploy",
              }),
              run({
                botId: "ben",
                status: "waiting_input",
                taskId: "task-post",
                delegationId: "card-post",
              }),
              run({
                botId: "cy",
                status: "running",
                threadId: "cy-private-chat",
                leaseExpiresAt: new Date(now.getTime() + 60_000),
                taskId: "task-private",
              }),
            ];
          if (where.threadId)
            return [
              run({
                botId: "ada",
                status: "completed",
                completedAt: ago(120),
                taskId: "task-logs",
              }),
              run({
                botId: "ben",
                status: "failed",
                completedAt: ago(60),
                error: "Model credentials missing",
                taskId: "task-launch",
              }),
            ];
          return [{ botId: "cy", createdAt: ago(2), startedAt: ago(2), completedAt: null }];
        },
      ),
    },
    taughtSkill: {
      findMany: vi.fn(async () => [{ botId: "ada", name: "Rollback", goal: "Roll back a deploy" }]),
    },
    task: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        [
          { id: "task-deploy", prompt: "Deploy the staging build" },
          { id: "task-post", prompt: "framed prompt the directory should not prefer" },
          { id: "task-logs", prompt: "Rotate the logs" },
          { id: "task-launch", prompt: "Draft the launch post" },
          { id: "task-private", prompt: "Private side project" },
        ].filter((task) => where.id.in.includes(task.id)),
      ),
    },
    delegation: {
      findMany: vi.fn(async () => [{ id: "card-post", card: { goal: "Send the invoice" } }]),
    },
  };
  const prisma = new Proxy(reads, {
    get(target, model: string) {
      const delegate = target[model as keyof typeof target];
      if (!delegate) throw new Error(`unexpected ${model} access`);
      return new Proxy(delegate, {
        get(methods, method: string) {
          const fn = methods[method as keyof typeof methods];
          if (!fn) throw new Error(`unexpected ${model}.${method}`);
          return fn;
        },
      });
    },
  });
  return { prisma: prisma as unknown as PrismaClient, reads };
}

describe("room member directory", () => {
  it("answers a status question from run records without waking or asking any member", async () => {
    const { prisma, reads } = readOnlyPrisma();
    const directory = await loadRoomMemberDirectory(prisma, scope, "group", "chief", now);

    expect(directory?.split("\n").slice(1)).toEqual([
      '- Ada (id: ada) — Ops engineer: Ships builds. Skills: Rollback. Now: working here on "Deploy the staging build" (started 4 min ago). Last here: finished "Rotate the logs" 2 h ago.',
      '- Ben (id: ben) — Writer: Drafts posts. Now: waiting for the user here on "Send the invoice". Last here: failed "Draft the launch post" 1 h ago (Model credentials missing).',
      "- Cy (id: cy) — Researcher. Now: busy elsewhere. Last active 2 min ago.",
    ]);
    expect(directory).not.toContain("Private side project");
    expect(directory).not.toContain("Chief (id: chief)");
    // Task text is read only for this room's runs.
    expect(reads.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["task-deploy", "task-post", "task-logs", "task-launch"] } },
      }),
    );
  });

  it("has nothing to list for a room without other members", async () => {
    const prisma = {
      chatGroup: {
        findFirst: vi.fn(async () => ({
          thread: { id: "room" },
          members: [
            { bot: { id: "chief", name: "Chief", title: "", description: "", computer: null } },
          ],
        })),
      },
    } as unknown as PrismaClient;
    await expect(
      loadRoomMemberDirectory(prisma, scope, "group", "chief", now),
    ).resolves.toBeUndefined();
  });
});
