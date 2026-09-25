import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@ardurbot/adapters";
import type { Brief } from "@ardurbot/contracts";
import { maintainBriefs } from "@ardurbot/memory";
import { describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
describe.skipIf(!hasDb)("Chief of Staff context product journey", () => {
  it("keeps two group briefs isolated, rewrites with no tools, and records actual executor context", async () => {
    const stable: string[] = [];
    const groups = ["Alpha", "Beta", "Alpha"];
    const model = await startModelEmulator({
      steps: groups.flatMap((group, index) => [
        {
          expect(request) {
            stable.push(
              JSON.stringify(
                request.messages.filter(
                  (message) => message.role === "system" || message.role === "developer",
                ),
              ),
            );
            const history = JSON.stringify(request.messages);
            expect(history).toContain(`Plan ${group}`);
            expect(history).not.toContain(`Release ${group === "Alpha" ? "Beta" : "Alpha"}`);
            if (index === 2) expect(history).toContain("Release Alpha");
          },
          response: { type: "text" as const, text: `Release ${group} on Friday.` },
        },
        {
          expect(request) {
            expect(request.tools ?? []).toHaveLength(0);
            expect(JSON.stringify(request.messages)).toContain(`Release ${group} on Friday.`);
          },
          response: {
            type: "text" as const,
            text: `## Goal\nRelease ${group}\n## People and bots\nChief\n## Open items\nReview ${group}\n## Last decisions\nFriday\n## Pointers\n`,
          },
        },
      ]),
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "ardurbot-context-"));
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: origin,
        webOrigin: origin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        encryptionKey: "context-fixture-encryption-key",
      });
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `context-${randomUUID()}@example.test`,
          password: "password12",
          name: "Context fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      async function rpc<T>(procedure: string, input: unknown): Promise<T> {
        const response = await handles!.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin },
          body: JSON.stringify({ json: input }),
        });
        const body = (await response.json()) as { json: T; error?: { message?: string } };
        if (!response.ok || body.error)
          throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
        return body.json;
      }
      await rpc("models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: "local",
      });
      const chief = await rpc<{ id: string }>("bots/create", {
        name: "Chief",
        title: "Chief of Staff",
        description: "Coordinate work",
        instructions: "Use the group brief to coordinate work.",
        notifyOnFinish: false,
      });
      const worker = await rpc<{ id: string }>("bots/create", {
        name: "Builder",
        title: "",
        description: "",
        notifyOnFinish: false,
      });
      await rpc("bots/update", {
        botId: chief.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
        concurrentRuns: 3,
      });
      const alpha = await rpc<{ id: string }>("groups/create", {
        name: "Alpha",
        botIds: [chief.id, worker.id],
      });
      const beta = await rpc<{ id: string }>("groups/create", {
        name: "Beta",
        botIds: [chief.id, worker.id],
      });
      await rpc("groups/update", { groupId: alpha.id, coordinatorBotId: chief.id });
      await rpc("groups/update", { groupId: beta.id, coordinatorBotId: chief.id });
      const runs: string[] = [];
      for (const [index, group] of [alpha, beta, alpha].entries()) {
        const sent = await rpc<{ runId: string }>("threads/send", {
          groupId: group.id,
          text: `Plan ${groups[index]}`,
        });
        runs.push(sent.runId);
        await expect
          .poll(
            async () => {
              const row = await handles!.prisma.botBrief.findFirst({
                where: { botId: chief.id, groupKey: group.id },
                include: { thread: true },
              });
              return (
                row?.pendingRunId === sent.runId &&
                row.leaseExpiresAt === null &&
                row.lastMessageSeq === row.thread.nextMessageSeq - 1
              );
            },
            { timeout: 20_000, interval: 100 },
          )
          .toBe(true);
      }
      model.assertComplete();
      expect(stable[0]).toBe(stable[2]);
      const briefs = await rpc<Brief[]>("briefs/list", { botId: chief.id });
      const a = briefs.find((brief) => brief.groupId === alpha.id)!;
      const b = briefs.find((brief) => brief.groupId === beta.id)!;
      expect(a.content).toContain("Release Alpha");
      expect(a.content).not.toContain("Release Beta");
      expect(b.content).toContain("Release Beta");
      expect(a.documentId).not.toBe(b.documentId);
      expect(a.revision).toBeGreaterThanOrEqual(1);
      const rows = await handles.prisma.run.findMany({ where: { id: { in: runs } } });
      for (const row of rows) {
        expect(row.status).toBe("completed");
        expect(row.routingRule).toBe("group-coordinator");
        expect(row.contextSnapshot).toMatchObject({
          recallRan: false,
          cachedTokens: null,
          timeToFirstTokenMs: expect.any(Number),
          queueWaitMs: expect.any(Number),
          layers: { stable: expect.any(Number), message: expect.any(Number) },
        });
      }
      const metrics = await rpc<{
        today: Array<{
          botId: string;
          groupId: string | null;
          runs: number;
          cacheHitRatio: number | null;
        }>;
      }>("metrics/context", { botId: chief.id });
      expect(metrics.today.find((row) => row.groupId === null)).toMatchObject({
        runs: 3,
        cacheHitRatio: null,
      });
      expect(
        await handles.prisma.event.count({ where: { runId: { in: runs }, type: "run.context" } }),
      ).toBeGreaterThanOrEqual(6);
      const changedThread = await handles.prisma.thread.findUniqueOrThrow({
        where: { id: a.threadId },
      });
      await handles.prisma.$transaction(async (tx) => {
        await tx.message.create({
          data: {
            threadId: a.threadId,
            botId: worker.id,
            role: "assistant",
            seq: changedThread.nextMessageSeq,
            blocks: [{ kind: "text", text: "Builder completed the review." }],
          },
        });
        await tx.thread.update({
          where: { id: a.threadId },
          data: { nextMessageSeq: { increment: 1 } },
        });
      });
      const refreshed: string[] = [];
      await maintainBriefs(handles.prisma, async (runId) => {
        refreshed.push(runId);
      });
      expect(refreshed).toContain(runs[2]);
      expect(refreshed).not.toContain(runs[1]);
      expect(refreshed.length).toBeLessThanOrEqual(5);
    } finally {
      await handles?.stop();
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
