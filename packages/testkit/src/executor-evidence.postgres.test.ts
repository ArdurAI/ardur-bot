import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeSandboxProvider, ScriptedAgentRuntime } from "@ardurbot/adapters";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { buildEvidenceBundle, verifyChain, verifySeal } from "../../evidence/src/index.js";
import { sessionCookieHeader } from "./index.js";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe.sequential : describe.skip;
// Keep API graph loading outside the hook budget, as in executor-lifecycle.test.ts.
const api = hasDb ? await import("../../../apps/api/src/app.ts") : undefined;
const origin = "http://127.0.0.1:5173";

describeIntegration("governance-on executor evidence (PostgreSQL)", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string | undefined;
  const runtime = new ScriptedAgentRuntime();
  const sandbox = new FakeSandboxProvider();

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ardurbot-executor-evidence-"));
    handles = await api!.createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      dataDir,
      authUrl: origin,
      webOrigin: origin,
      sandboxProvider: "fake",
      sandbox,
      agentRuntime: "scripted",
      runtime,
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      signupsEnabled: "true",
      encryptionKey: "executor-evidence-fixture-encryption-key",
    });
    // This fixture scripts main turns only, not background brief model turns.
    vi.spyOn(handles.executor, "refreshBrief").mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await handles?.stop();
    vi.restoreAllMocks();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("records allowed, owner-denied and owner-approved tools, then seals a private verified chain", async () => {
    const fileArgs = { path: "fixture-folder/allowed.txt", content: "fixture file argument value" };
    const deniedArgs = {
      collection: "fixture-denied-collection",
      title: "fixture-denied-title",
      body: "fixture-denied-body",
    };
    const approvedArgs = {
      collection: "fixture-approved-collection",
      title: "fixture-approved-title",
      body: "fixture-approved-body",
    };
    let turn = 0;
    const model = vi.spyOn(runtime, "run").mockImplementation(async function* (request) {
      expect(request.providerPurpose).toBe("main");
      const current = turn++;
      if (current === 0) {
        yield {
          type: "tool" as const,
          name: "write_file",
          args: fileArgs,
          executionId: "allowed-call",
        };
        yield {
          type: "tool" as const,
          name: "destination.write",
          args: deniedArgs,
          executionId: "denied-call",
        };
        return;
      }
      if (current === 1) {
        yield {
          type: "tool" as const,
          name: "destination.write",
          args: approvedArgs,
          executionId: "approved-call",
        };
        return;
      }
      expect(current).toBe(2);
      yield {
        type: "tool" as const,
        name: "destination.write",
        args: approvedArgs,
        executionId: "approved-call",
      };
      yield { type: "done" as const, text: "Evidence fixture complete." };
    });
    const sealJob = vi.spyOn(handles.executor, "sealRunEvidence");
    const write = vi.spyOn(sandbox, "writeFile");
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `executor-evidence-${randomUUID()}@example.test`,
        password: "password12",
        name: "Evidence fixture",
      }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name: "Evidence fixture",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    await handles.prisma.spaceFeature.upsert({
      where: { spaceId_feature: { spaceId: me.spaceId, feature: "governance" } },
      create: { spaceId: me.spaceId, feature: "governance", state: "enabled" },
      update: { state: "enabled" },
    });
    await handles.prisma.actionAutoReviewPreference.upsert({
      where: { spaceId_userId: { spaceId: me.spaceId, userId: me.userId } },
      create: { spaceId: me.spaceId, userId: me.userId, enabled: false },
      update: { enabled: false },
    });
    await handles.prisma.actionApprovalRule.create({
      data: {
        spaceId: me.spaceId,
        createdByUserId: me.userId,
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "destination.write",
      },
    });
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const task = await handles.prisma.task.create({
      data: {
        spaceId: me.spaceId,
        userId: me.userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Exercise evidence decisions.",
        status: "queued",
      },
    });
    const run = await handles.prisma.run.create({
      data: {
        spaceId: me.spaceId,
        userId: me.userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "queued",
        trigger: "user",
      },
    });
    const recordCount = () => handles.prisma.evidenceRecord.count({ where: { runId: run.id } });
    const runStatus = async () =>
      (await handles.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status;
    const answer = async (decision: "deny" | "allow") => {
      expect(await runStatus()).toBe("waiting_input");
      const card = await handles.prisma.message.findFirstOrThrow({
        where: { runId: run.id, role: "bot" },
        orderBy: { seq: "desc" },
      });
      await rpc(cookie, "threads/answer", {
        botId: bot.id,
        runId: run.id,
        messageId: card.id,
        answer: decision,
      });
    };

    await handles.executor.continueRun(run.id, "evidence-worker");
    expect(await recordCount()).toBe(2);
    expect(handles.connector.records).toEqual([]);
    await answer("deny");
    await expect.poll(recordCount, { timeout: 15_000, interval: 100 }).toBe(4);
    expect(handles.connector.records).toEqual([]);
    await answer("allow");
    await expect.poll(runStatus, { timeout: 15_000, interval: 100 }).toBe("completed");
    expect(model).toHaveBeenCalledTimes(3);
    expect(
      write.mock.calls.filter(
        ([, file]) =>
          file.path.endsWith(fileArgs.path) &&
          new TextDecoder().decode(file.content) === fileArgs.content,
      ),
    ).toHaveLength(1);
    expect(handles.connector.records).toEqual([expect.objectContaining(approvedArgs)]);

    // Exercise the real background handler, including idempotent terminal-job delivery.
    await handles.jobs.enqueue({
      name: "evidence.seal",
      payload: { runId: run.id },
      replaceKey: run.id,
    });
    await expect
      .poll(
        async () =>
          Boolean(await handles.prisma.evidenceSeal.findUnique({ where: { runId: run.id } })),
        { timeout: 15_000, interval: 100 },
      )
      .toBe(true);
    expect(sealJob).toHaveBeenCalledWith(run.id);
    const records = await handles.prisma.evidenceRecord.findMany({
      where: { runId: run.id },
      orderBy: { seq: "asc" },
    });
    const seal = await handles.prisma.evidenceSeal.findUniqueOrThrow({ where: { runId: run.id } });
    const key = await handles.prisma.evidenceKey.findUniqueOrThrow({
      where: { kid: records[0]!.kid },
    });
    const journal = records.map((row) => row.jws);
    expect(records.map((row) => row.decisionKind)).toEqual([
      "allowed_by_default",
      "asked",
      "denied_by_owner",
      "asked",
      "approved_by_owner",
    ]);
    expect(records.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(seal).toMatchObject({ recordCount: 5, gapCount: 0, headSha256: records.at(-1)!.sha256 });
    expect(verifyChain(journal, key.publicKeyPem).ok).toBe(true);
    expect(verifySeal(seal.jws, journal, key.publicKeyPem).ok).toBe(true);
    // Check decoded claims too: searching only base64url compact tokens would miss leaks.
    const storedJws = [...journal, seal.jws];
    const stored = storedJws
      .flatMap((jws) => [jws, Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8")])
      .join("\n");
    for (const value of [
      ...Object.values(fileArgs),
      ...Object.values(deniedArgs),
      ...Object.values(approvedArgs),
    ])
      expect(stored).not.toContain(value);

    const sampleDir = process.env.ARDUR_EVIDENCE_SAMPLE_DIR;
    if (sampleDir) {
      await mkdir(sampleDir, { recursive: true });
      for (const file of buildEvidenceBundle({
        runId: run.id,
        records: journal,
        seal: seal.jws,
        publicKeyPem: key.publicKeyPem,
      }))
        await writeFile(path.join(sampleDir, file.path), file.contents, "utf8");
    }
  });

  async function rpc<T>(cookie: string, procedure: string, body: unknown = {}): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!response.ok || payload.error)
      throw new Error(payload.error?.message ?? `${procedure} failed (${response.status})`);
    return payload.json as T;
  }
});
