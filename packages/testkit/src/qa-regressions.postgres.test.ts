import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AppBootstrap,
  Comparison,
  MemoryBundle,
  MemoryDocumentHead,
  RunActivityRow,
  ThreadSnapshot,
} from "@ardurbot/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.js";
import { sessionCookieHeader } from "./index.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
describe.skipIf(!enabled)("QA fixes through persisted RPCs", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string;
  let cookie: string;
  async function start() {
    const { createApp } = await import("../../../apps/api/src/app.js");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      authUrl: origin,
      webOrigin: origin,
      signupsEnabled: "true",
      encryptionKey: "offline-qa-fixture-encryption-key",
    });
  }
  async function rpc<T>(procedure: string, input: unknown = {}): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ json: input }),
    });
    const body = (await response.json()) as { json: T };
    expect(response.status, `${procedure}: ${JSON.stringify(body)}`).toBe(200);
    return body.json;
  }
  const bot = (name: string) =>
    rpc<{ id: string }>("bots/create", {
      name,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "qa-regressions-"));
    await start();
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `qa-${randomUUID()}@example.test`,
        password: "offline-password-123",
        name: "QA fixture",
      }),
    });
    expect(signup.status).toBeLessThan(400);
    cookie = sessionCookieHeader(signup);
  });
  afterAll(async () => {
    await handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("exports and accepts a bot's seeded memory after its first edit", async () => {
    const created = await bot("Memory fixture");
    const seed = await handles.prisma.memoryDocument.findFirstOrThrow({
      where: { botId: created.id },
    });
    expect(await handles.prisma.memoryRevision.count({ where: { documentId: seed.id } })).toBe(0);
    await rpc<MemoryDocumentHead>("memory/update", {
      documentId: seed.id,
      content: "Edited memory",
      expectedRevision: seed.revision,
    });
    const bundle = await rpc<MemoryBundle>("memory/export");
    expect(
      bundle.documents.find((doc) => doc.id === seed.id)?.revisions.map(({ content }) => content),
    ).toEqual([seed.content, "Edited memory"]);
    await rpc("memory/import", { bundle });
    const history = await rpc<{ items: unknown[] }>("memory/history", { documentId: seed.id });
    expect(history.items).toHaveLength(2);
  });

  it("resets a computer after releasing the caller's open-screen lease", async () => {
    const created = await bot("Computer fixture");
    await rpc("computer/boot", { botId: created.id });
    await rpc("computer/takeover", { botId: created.id });
    const before = await handles.prisma.bot.findUniqueOrThrow({
      where: { id: created.id },
      include: { computer: true },
    });
    expect(before.computer?.controlLeaseId).toBeTruthy();
    await rpc("computer/reset", { botId: created.id });
    const after = await handles.prisma.computer.findUniqueOrThrow({
      where: { id: before.computerId! },
    });
    expect(after.controlLeaseId).toBeNull();
    expect(after.maintenanceId).toBeNull();
  });

  it("reads comparison threads, bootstrap and Activity after an API restart", async () => {
    const first = await bot("Comparison first");
    const second = await bot("Comparison second");
    const comparison = await rpc<Comparison>("comparisons/create", {
      coordinatorBotId: first.id,
      participantBotIds: [first.id, second.id],
      text: "Compare a short answer.",
      clientNonce: randomUUID(),
    });
    expect(comparison.participants).toHaveLength(2);
    const persisted = await handles.prisma.run.findMany({
      where: { botId: { in: [first.id, second.id] } },
    });
    expect(persisted.map((run) => run.trigger)).toEqual(
      expect.arrayContaining(["comparison", "comparison-coordinator"]),
    );
    const ids = persisted.map((run) => run.id);
    await expect
      .poll(
        () =>
          handles.prisma.run.count({
            where: { id: { in: ids }, status: { notIn: ["completed", "failed", "cancelled"] } },
          }),
        { timeout: 10000 },
      )
      .toBe(0);
    // Hold the persisted fixture at an approval boundary so restart cannot finish it
    // before both thread readers exercise their run validators.
    await handles.prisma.run.updateMany({
      where: { id: { in: ids } },
      data: { status: "waiting_input", completedAt: null },
    });
    await handles.stop();
    await start();
    for (const botId of [first.id, second.id]) {
      const thread = await rpc<ThreadSnapshot>("threads/get", { botId });
      expect(thread.botId).toBe(botId);
      expect(thread.run?.trigger).toMatch(/^comparison/);
      const bootstrap = await rpc<AppBootstrap>("bootstrap", { botId });
      expect(bootstrap.thread?.botId).toBe(botId);
    }
    const active = await rpc<{ runs: RunActivityRow[] }>("runs/list", { filter: "active" });
    const recent = await rpc<{ runs: RunActivityRow[] }>("runs/list", { filter: "recent" });
    expect(
      [...active.runs, ...recent.runs].some((run) => run.trigger.startsWith("comparison")),
    ).toBe(true);
    await handles.prisma.run.updateMany({
      where: { id: { in: ids } },
      data: { status: "cancelled", completedAt: new Date() },
    });
  });

  it("records actual routine Test run attempts with outcome and time", async () => {
    const created = await bot("Routine fixture");
    const routine = await rpc<{ id: string }>("routines/create", {
      botId: created.id,
      name: "Routine fixture",
      prompt: "Say hello.",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: false,
    });
    expect(await rpc("routines/history", { routineId: routine.id })).toEqual([]);
    const run = await rpc<{ runId: string }>("routines/testRun", {
      routineId: routine.id,
      clientNonce: randomUUID(),
    });
    await expect
      .poll(
        async () =>
          (await handles.prisma.run.findUniqueOrThrow({ where: { id: run.runId } })).completedAt,
        { timeout: 10000 },
      )
      .not.toBeNull();
    const stored = await handles.prisma.run.findUniqueOrThrow({ where: { id: run.runId } });
    expect(await rpc("routines/history", { routineId: routine.id })).toEqual([
      {
        id: run.runId,
        status: stored.status,
        createdAt: stored.createdAt.toISOString(),
        completedAt: stored.completedAt!.toISOString(),
      },
    ]);
  });
});
