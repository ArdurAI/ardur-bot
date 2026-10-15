import type { Prisma, PrismaClient } from "@ardurbot/db";
import { answerRunInput } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { claimBotRun } from "./context/concurrency.js";
import { createRunSecretWriter } from "./run-secret.js";
import { EncryptedSecretStore } from "./secrets.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([false, true])(
  "saves a credential during a concurrent brief claim without deadlocking (rotation: %s)",
  async (rotation) => {
    const firstAnswerLock = barrier();
    const claimBlocked = barrier();
    const resumeAnswer = barrier();
    const owners = new Map<string, string>();
    const waiting = new Map<string, string>();
    const released = new Map<string, ReturnType<typeof barrier>>();
    const destination = {
      name: "example_api",
      origin: "https://api.example.test",
      auth: { type: "bearer" },
    };
    let answerHasLock = false;
    let status = "waiting_input";
    const saved = vi.fn();

    // Model exclusive row locks, including reentrant acquisition and wait cycles.
    // Hold the answer after its first lock until maintenance is blocked on a lock.
    const acquire = async (transaction: string, resource: string) => {
      while (owners.has(resource) && owners.get(resource) !== transaction) {
        const owner = owners.get(resource)!;
        waiting.set(transaction, owner);
        if (waiting.get(owner) === transaction) throw new Error("deadlock detected");
        if (transaction === "brief") claimBlocked.resolve();
        await released.get(owner)!.promise;
        waiting.delete(transaction);
      }
      owners.set(resource, transaction);
      if (transaction === "answer" && !answerHasLock) {
        answerHasLock = true;
        firstAnswerLock.resolve();
        await resumeAnswer.promise;
      }
    };
    const client = (transaction: string) =>
      ({
        $transaction: async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          released.set(transaction, barrier());
          const tx = {
            $queryRaw: async (sql: TemplateStringsArray) => {
              await acquire(transaction, sql.join("").includes("FROM bots") ? "bot" : "thread");
              return [];
            },
            bot: {
              findUniqueOrThrow: async () => ({
                concurrentRuns: null,
                space: { concurrentRuns: 1 },
              }),
            },
            botBrief: { count: async () => 0 },
            run: {
              findFirst: async () =>
                status === "waiting_input" ? { botId: "bot-1", userId: "user-1" } : null,
              findUnique: async () => ({ status, threadId: "thread-1" }),
              count: async () => 0,
              updateMany: async () => {
                status = "queued";
                return { count: 1 };
              },
            },
            message: {
              findFirst: async () => ({
                id: "message-1",
                blocks: [
                  { kind: "ask", text: "API key", input: "secret", credential: destination },
                ],
              }),
              update: async () => ({}),
            },
            botSecret: {
              findFirst: async () => (rotation ? { id: "secret-1", ...destination } : null),
              count: async () => 0,
              create: saved,
              update: saved,
            },
            externalEffect: { updateMany: async () => ({ count: 1 }) },
            thread: {
              findUniqueOrThrow: async () => ({ groupId: null }),
              update: async () => ({ nextEventSeq: 1 }),
            },
            event: { create: async () => ({ threadId: "thread-1", seq: 1 }) },
          };
          try {
            return await work(tx as unknown as Prisma.TransactionClient);
          } finally {
            for (const [resource, owner] of owners)
              if (owner === transaction) owners.delete(resource);
            waiting.delete(transaction);
            released.get(transaction)!.resolve();
          }
        },
      }) as unknown as PrismaClient;

    const answer = answerRunInput(
      client("answer"),
      {
        runId: "run-1",
        threadId: "thread-1",
        spaceId: "space-1",
        messageId: "message-1",
        answeredByUserId: "user-1",
        answer: "fake-replacement-key",
      },
      undefined,
      createRunSecretWriter(new EncryptedSecretStore("test-only-encryption-key")),
    );
    // Observe failures immediately while the barriers force the interleaving.
    const answered = expect(answer).resolves.toBe(true);
    await firstAnswerLock.promise;
    const claim = vi.fn(async () => ({ count: 1 }));
    const brief = claimBotRun(client("brief"), {
      runId: "brief-run-1",
      botId: "bot-1",
      threadId: "thread-1",
      now: new Date(),
      claim,
    });
    await claimBlocked.promise;
    resumeAnswer.resolve();
    await answered;
    expect(await brief).toEqual({ count: 1 });
    expect(saved).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(status).toBe("queued");
  },
);
