import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@ardurbot/adapters";
import { rejectDelegation, setGroupMemberPin } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { listPiCatalog, suggestedModelEffort } from "../../adapters/src/index.js";
import { sessionCookieHeader } from "./index.js";

const hasDatabase = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
type App = { request: (input: string, init?: RequestInit) => Promise<Response> };

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (!response.ok || !body.json) throw new Error(body.error?.message ?? `${procedure} failed`);
  return body.json;
}

describe.skipIf(!hasDatabase)("group model visible journey (PostgreSQL)", () => {
  it("captures a room member pin, keeps DMs global, and copies archived choices", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "group-model-visible-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.js");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
      });
      stop = handles.stop;
      vi.spyOn(handles.executor, "refreshBrief").mockResolvedValue(undefined);
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `group-visible-${randomUUID()}@ardurbot.test`,
          password: "password12",
          name: "Fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const me = await rpc<{ userId: string; spaceId: string }>(handles.app, cookie, "me");
      const first = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "First",
        title: "",
        description: "",
        instructions: "",
      });
      const second = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "Second",
        title: "",
        description: "",
        instructions: "",
      });
      const group = await rpc<{ id: string; threadId: string }>(
        handles.app,
        cookie,
        "groups/create",
        {
          name: "Room",
          botIds: [first.id, second.id],
        },
      );
      await setGroupMemberPin(
        handles.prisma,
        {
          ...me,
          email: "fixture@example.test",
          isDeploymentOwner: true,
        },
        group.id,
        first.id,
        {
          runtimeKind: "pi",
          provider: "scripted",
          modelId: "scripted",
          effort: "off",
          credentialId: "scripted",
        },
      );
      const send = async (input: { groupId?: string; botId?: string; text: string }) => {
        const dispatched = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", input);
        await expect
          .poll(
            async () =>
              (
                await handles.prisma.run.findUnique({
                  where: { id: dispatched.runId },
                  select: { status: true },
                })
              )?.status,
            { timeout: 20_000, interval: 100 },
          )
          .toBe("completed");
        return handles.prisma.run.findUniqueOrThrow({ where: { id: dispatched.runId } });
      };
      const room = await send({ groupId: group.id, text: "@First say ready" });
      expect(room.runtimePin).toMatchObject({ provider: "scripted", modelId: "scripted" });
      expect(room.runtimePinSource).toMatchObject({
        kind: "group-member",
        groupId: group.id,
        botId: first.id,
      });
      expect(room.usageGroupId).toBe(group.id);
      const dm = await send({ botId: first.id, text: "say ready" });
      expect(dm.runtimePinSource).not.toMatchObject({ kind: "group-member" });
      expect(dm.usageGroupId).toBeNull();
      const copy = await rpc<{
        id: string;
        members: Array<{ botId: string; runtimePin: unknown }>;
      }>(handles.app, cookie, "groups/duplicate", { groupId: group.id });
      expect(copy.members.find((member) => member.botId === first.id)?.runtimePin).toMatchObject({
        modelId: "scripted",
      });
      await rpc(handles.app, cookie, "groups/archive", { groupId: group.id });
      const archived = await handles.prisma.chatGroupMember.findUniqueOrThrow({
        where: { groupId_botId: { groupId: group.id, botId: first.id } },
      });
      expect(archived.runtimePin).toMatchObject({ modelId: "scripted" });
    } finally {
      await stop?.();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps an admitted room pin across an edit, uses the next choice, and fails closed after credential removal", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "group-model-edit-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.js");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
      });
      stop = handles.stop;
      vi.spyOn(handles.executor, "refreshBrief").mockResolvedValue(undefined);
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `group-edit-${randomUUID()}@ardurbot.test`,
          password: "password12",
          name: "Fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const me = await rpc<{ userId: string; spaceId: string }>(handles.app, cookie, "me");
      const first = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "First",
        title: "",
        description: "",
        instructions: "",
      });
      const second = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "Second",
        title: "",
        description: "",
        instructions: "",
      });
      const group = await rpc<{ id: string; threadId: string }>(
        handles.app,
        cookie,
        "groups/create",
        {
          name: "Room",
          botIds: [first.id, second.id],
        },
      );
      const actor = { ...me, email: "fixture@example.test", isDeploymentOwner: true };
      await setGroupMemberPin(handles.prisma, actor, group.id, first.id, {
        runtimeKind: "pi",
        provider: "scripted",
        modelId: "scripted",
        effort: "off",
        credentialId: "scripted",
      });
      const active = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        groupId: group.id,
        text: "@First keep working until I stop you",
      });
      await expect
        .poll(
          async () => {
            const run = await handles.prisma.run.findUnique({ where: { id: active.runId } });
            return run?.status === "running" && run.runtimePin ? run.status : null;
          },
          {
            timeout: 20_000,
            interval: 100,
          },
        )
        .toBe("running");
      const admitted = await handles.prisma.run.findUniqueOrThrow({ where: { id: active.runId } });
      expect(admitted.runtimePin).toMatchObject({ provider: "scripted", revision: 1 });
      expect(admitted.runtimePinSource).toMatchObject({ kind: "group-member", groupId: group.id });

      const entry = listPiCatalog().find((item) => item.provider === "openai" && !item.placeholder);
      expect(entry).toBeDefined();
      const credential = await rpc<{ id: string }>(handles.app, cookie, "models/connect", {
        provider: entry!.provider,
        apiKey: "fixture-key",
      });
      const listed = await rpc<{
        members: Array<{ botId: string; memberId: string; modelPinRevision: number }>;
      }>(handles.app, cookie, "groups/get", { groupId: group.id });
      const member = listed.members.find((candidate) => candidate.botId === first.id)!;
      await rpc(handles.app, cookie, "groups/setMemberModelPin", {
        groupId: group.id,
        botId: first.id,
        memberId: member.memberId,
        expectedRevision: member.modelPinRevision,
        pin: {
          runtimeKind: "pi",
          provider: entry!.provider,
          modelId: entry!.id,
          effort: suggestedModelEffort(entry!.thinkingLevels ?? ["off"]),
          credentialId: credential.id,
        },
      });
      expect(
        (await handles.prisma.run.findUniqueOrThrow({ where: { id: active.runId } })).runtimePin,
      ).toEqual(admitted.runtimePin);
      await rpc(handles.app, cookie, "threads/stop", { groupId: group.id });
      await expect
        .poll(
          async () =>
            (await handles.prisma.run.findUnique({ where: { id: active.runId } }))?.status,
          {
            timeout: 20_000,
            interval: 100,
          },
        )
        .toBe("cancelled");
      expect(
        (await handles.prisma.run.findUniqueOrThrow({ where: { id: active.runId } })).runtimePin,
      ).toEqual(admitted.runtimePin);

      const next = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        groupId: group.id,
        text: "@First say ready",
      });
      await expect
        .poll(
          async () => (await handles.prisma.run.findUnique({ where: { id: next.runId } }))?.status,
          {
            timeout: 20_000,
            interval: 100,
          },
        )
        .toBe("completed");
      expect(
        (await handles.prisma.run.findUniqueOrThrow({ where: { id: next.runId } })).runtimePin,
      ).toMatchObject({
        provider: entry!.provider,
        modelId: entry!.id,
        credentialId: credential.id,
        revision: 2,
      });

      await handles.prisma.userModelCredential.delete({ where: { id: credential.id } });
      const failed = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        groupId: group.id,
        text: "@First say ready again",
      });
      await expect
        .poll(
          async () =>
            (await handles.prisma.run.findUnique({ where: { id: failed.runId } }))?.status,
          {
            timeout: 20_000,
            interval: 100,
          },
        )
        .toBe("failed");
      const failedRun = await handles.prisma.run.findUniqueOrThrow({ where: { id: failed.runId } });
      const failedEvent = await handles.prisma.event.findFirstOrThrow({
        where: { runId: failed.runId, type: "run.failed" },
      });
      expect(failedEvent.payload).toMatchObject({
        runtimeProblem: {
          code: "pin-credential-missing",
          source: { kind: "group-member", groupId: group.id },
        },
      });
      expect(
        await handles.prisma.message.count({
          where: { threadId: group.threadId, runId: failed.runId, role: "system" },
        }),
      ).toBe(1);
      expect(
        await handles.prisma.run.count({
          where: { sourceMessageId: failedRun.sourceMessageId, status: "queued" },
        }),
      ).toBe(0);
    } finally {
      await stop?.();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 90_000);

  it("freezes a room handoff recipient at admission and preserves its group source through failed rework", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "group-model-handoff-"));
    let stop: (() => Promise<void>) | undefined;
    let releaseRecipient = () => undefined;
    let restore: (() => void) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.js");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
      });
      stop = handles.stop;
      vi.spyOn(handles.executor, "refreshBrief").mockResolvedValue(undefined);
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `group-handoff-${randomUUID()}@ardurbot.test`,
          password: "password12",
          name: "Fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const me = await rpc<{ userId: string; spaceId: string }>(handles.app, cookie, "me");
      const first = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "First",
        title: "",
        description: "",
        instructions: "",
      });
      const second = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "Second",
        title: "",
        description: "",
        instructions: "",
      });
      const group = await rpc<{ id: string; threadId: string }>(
        handles.app,
        cookie,
        "groups/create",
        {
          name: "Room",
          botIds: [first.id, second.id],
        },
      );
      const actor = { ...me, email: "fixture@example.test", isDeploymentOwner: true };
      const entry = listPiCatalog().find((item) => item.provider === "openai" && !item.placeholder);
      expect(entry).toBeDefined();
      const credential = await rpc<{ id: string }>(handles.app, cookie, "models/connect", {
        provider: entry!.provider,
        apiKey: "fixture-key",
      });
      const originalPin = (
        await setGroupMemberPin(handles.prisma, actor, group.id, second.id, {
          runtimeKind: "pi",
          provider: entry!.provider,
          modelId: entry!.id,
          effort: suggestedModelEffort(entry!.thinkingLevels ?? ["off"]),
          credentialId: credential.id,
        })
      ).runtimePin;
      let unblock!: () => void;
      const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      releaseRecipient = unblock;
      const continueRun = handles.executor.continueRun.bind(handles.executor);
      const spy = vi
        .spyOn(handles.executor, "continueRun")
        .mockImplementation(async (runId, workerId) => {
          const run = await handles.prisma.run.findUnique({ where: { id: runId } });
          if (run?.botId === second.id && run.delegationId) await gate;
          return continueRun(runId, workerId);
        });
      restore = () => spy.mockRestore();
      await rpc(handles.app, cookie, "threads/send", {
        groupId: group.id,
        text: "@First hand this to Second for the draft",
      });
      await expect
        .poll(
          async () =>
            handles.prisma.delegation.count({
              where: { actingBotId: second.id, kind: "group-handoff" },
            }),
          { timeout: 20_000, interval: 100 },
        )
        .toBe(1);
      const assignment = await handles.prisma.delegation.findFirstOrThrow({
        where: { actingBotId: second.id, kind: "group-handoff" },
      });
      const recipient = await handles.prisma.run.findUniqueOrThrow({
        where: { id: assignment.runId! },
      });
      expect(recipient.status).toBe("queued");
      expect(recipient.runtimePin).toEqual(originalPin);
      expect(recipient.runtimePinSource).toMatchObject({
        kind: "group-member",
        groupId: group.id,
        botId: second.id,
      });
      await setGroupMemberPin(handles.prisma, actor, group.id, second.id, {
        runtimeKind: "pi",
        provider: "scripted",
        modelId: "scripted",
        effort: "off",
        credentialId: "scripted",
      });
      releaseRecipient();
      await expect
        .poll(
          async () =>
            (await handles.prisma.run.findUnique({ where: { id: recipient.id } }))?.status,
          {
            timeout: 20_000,
            interval: 100,
          },
        )
        .toBe("completed");
      expect(
        (await handles.prisma.run.findUniqueOrThrow({ where: { id: recipient.id } })).runtimePin,
      ).toEqual(originalPin);
      await expect
        .poll(
          async () =>
            (await handles.prisma.delegation.findUnique({ where: { id: assignment.id } }))?.status,
          {
            timeout: 20_000,
            interval: 100,
          },
        )
        .toBe("completed");
      const rework = await handles.prisma.$transaction(async (tx) => {
        const replacement = await rejectDelegation(
          tx,
          {
            userId: me.userId,
            spaceId: me.spaceId,
          },
          assignment.id,
          first.id,
          "Revise the draft",
        );
        await tx.userModelCredential.delete({ where: { id: credential.id } });
        return replacement;
      });
      const replacement = await handles.prisma.run.findUniqueOrThrow({
        where: { id: rework.runId },
      });
      expect(replacement.runtimePin).toEqual(originalPin);
      expect(replacement.runtimePinSource).toEqual(recipient.runtimePinSource);
      expect(replacement.usageGroupId).toBe(group.id);
      await handles.executor.continueRun(rework.runId, "rework-journey");
      await expect
        .poll(
          async () =>
            (await handles.prisma.run.findUnique({ where: { id: rework.runId } }))?.status,
          {
            timeout: 20_000,
            interval: 100,
          },
        )
        .toBe("failed");
      const reworkFailure = await handles.prisma.event.findFirstOrThrow({
        where: { runId: rework.runId, type: "run.failed" },
      });
      expect(reworkFailure.payload).toMatchObject({
        runtimeProblem: {
          code: "pin-credential-missing",
          source: { kind: "group-member", groupId: group.id },
        },
      });
      expect(
        await handles.prisma.message.count({
          where: {
            runId: rework.runId,
            threadId: group.threadId,
            role: "system",
            clientNonce: `group-model-failed:${rework.runId}`,
          },
        }),
      ).toBe(1);
    } finally {
      releaseRecipient();
      restore?.();
      await stop?.();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
