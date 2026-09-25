import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { BackgroundJobHandlers } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";

export function assertDisposableUrl(value: string) {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/scoreboard_trial_\d+$/.test(url.pathname)
  )
    throw new Error("Matrix requires a disposable loopback scoreboard database");
}

export async function until(predicate: () => Promise<boolean>, deadlineMs = 15000) {
  const end = performance.now() + deadlineMs;
  while (performance.now() < end) {
    if (await predicate()) return true;
    await delay(20);
  }
  return false;
}

/** Unselected work is explicitly excluded; callers supply every class they measure. */
export function fixtureHandlers(overrides: Partial<BackgroundJobHandlers>): BackgroundJobHandlers {
  const ignored = async () => undefined;
  return {
    "run.continue": ignored,
    "board.run": ignored,
    "briefs.maintain": ignored,
    "learning.curate": ignored,
    "learning.review": ignored,
    "memory.git-push": ignored,
    "memory.deliver": ignored,
    "routine.wakeup": ignored,
    "computer.update": ignored,
    "computer.sleep": ignored,
    "computer.control-expire": ignored,
    "skill.teaching-expire": ignored,
    "history.compact": ignored,
    "messaging.deliver": ignored,
    "cloud_agent.poll": ignored,
    ...overrides,
  };
}

export async function seedScope(prisma: PrismaClient) {
  const id = randomUUID();
  await prisma.user.create({
    data: { id, name: "Matrix fixture", email: `${id}@example.test`, emailVerified: true },
  });
  await prisma.organization.create({
    data: { id, name: "Matrix fixture", slug: id, createdAt: new Date() },
  });
  await prisma.space.create({ data: { id, organizationId: id, name: "Matrix fixture" } });
  await prisma.member.create({
    data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
  });
  await prisma.spaceMember.create({
    data: { id, spaceId: id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
  });
  const bot = await prisma.bot.create({
    data: { spaceId: id, userId: id, name: "Matrix fixture", color: "ink" },
  });
  const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
  return {
    spaceId: id,
    userId: id,
    botId: bot.id,
    threadId: thread.id,
    operationId: "matrix",
    traceId: "matrix",
    signal: new AbortController().signal,
  };
}

/** Observe only completed calls/transactions. Never block inside an uncommitted transaction. */
export function observeCommittedWrites(
  prisma: PrismaClient,
  observe: () => Promise<void>,
): PrismaClient {
  const writes = new Set([
    "create",
    "createMany",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
  ]);
  return new Proxy(prisma, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "$transaction")
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, target, args);
          await observe();
          return result;
        };
      if (typeof value === "function") return value.bind(target);
      if (
        !value ||
        typeof value !== "object" ||
        typeof property !== "string" ||
        property.startsWith("$")
      )
        return value;
      return new Proxy(value, {
        get(delegate, method) {
          const operation = Reflect.get(delegate, method);
          if (typeof operation !== "function") return operation;
          return (...args: unknown[]) => {
            const query = Reflect.apply(operation, delegate, args);
            if (!writes.has(String(method))) return query;
            if (!query || typeof query !== "object")
              throw new Error("Expected a lazy Prisma mutation query");
            // Keep Prisma's lazy query/requestTransaction contract for batch transactions.
            // Their queries bypass this observer; the transaction observer runs after commit.
            let completion: Promise<unknown> | undefined;
            return new Proxy(query, {
              get(pending, key) {
                const member = Reflect.get(pending, key);
                if (["then", "catch", "finally"].includes(String(key)))
                  return (...callbacks: unknown[]) => {
                    completion ??= Promise.resolve(pending).then(async (result) => {
                      await observe();
                      return result;
                    });
                    return Reflect.apply(Reflect.get(completion, key), completion, callbacks);
                  };
                return typeof member === "function" ? member.bind(pending) : member;
              },
            });
          };
        },
      });
    },
  });
}
