import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@ardurbot/adapters";
import { setGroupMemberPin } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
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
});
