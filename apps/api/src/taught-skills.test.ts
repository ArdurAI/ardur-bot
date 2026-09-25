import type { Actor } from "@ardurbot/contracts";
import { buildPlaybookFromRecording } from "@ardurbot/core";
import { memoryServiceFixture } from "@ardurbot/testkit/memory-fakes";
import { expect, it, vi } from "vitest";
import type { TaughtSkillsDeps } from "./taught-skills.js";
import { createTaughtSkillsService } from "./taught-skills.js";

it("keeps recording metadata while playbook edits, stale writes and deletion use the document lifecycle", async () => {
  const actor = { spaceId: "space", userId: "user" } as Actor;
  const row = {
    id: "taught",
    ...actor,
    botId: "bot",
    name: "Steps",
    goal: "Repeat a procedure",
    status: "saved",
    enabled: true,
    playbook: buildPlaybookFromRecording("Repeat a procedure", []),
    recording: { events: [], snapshots: [] },
    documentId: null as string | null,
    activeRevision: null as number | null,
    startedAt: null,
    expiresAt: null,
    stoppedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const memory = memoryServiceFixture({ ...actor, botId: "bot" });
  const prisma = {
    taughtSkill: {
      findFirst: vi.fn(async () => ({ ...row })),
      updateMany: vi.fn(async ({ data }: { data: object }) => {
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: object }) => {
        Object.assign(row, data);
        return { ...row };
      }),
      delete: vi.fn(),
    },
    bot: { findUnique: vi.fn(async () => null) },
  };
  const service = createTaughtSkillsService({
    prisma,
    memoryDocuments: memory.service,
  } as unknown as TaughtSkillsDeps);
  row.enabled = false;
  await expect(service.testRun(actor, row.id)).rejects.toThrow("Enable this skill");
  expect(prisma.bot.findUnique).not.toHaveBeenCalled();
  row.enabled = true;
  const edited = await service.updateDraft(actor, row.id, {
    expectedRevision: 1,
    playbook: { ...row.playbook, steps: ["Check each step."] },
  });
  expect(edited).toMatchObject({
    activeRevision: 2,
    playbook: { steps: ["Check each step."] },
    recording: { events: [], snapshots: [] },
  });
  expect(row.playbook).toEqual({});
  await expect(
    service.updateDraft(actor, row.id, { expectedRevision: 1, playbook: edited.playbook }),
  ).rejects.toMatchObject({ code: "MEMORY_CONFLICT" });
  await service.remove(actor, row.id);
  expect(prisma.taughtSkill.delete).not.toHaveBeenCalled();
  const context = {
    ...actor,
    operationId: "test",
    traceId: "test",
    signal: new AbortController().signal,
  };
  expect(await memory.service.read(row.documentId!, context)).toMatchObject({
    revision: 3,
    deletedAt: expect.any(String),
  });
  await memory.service.restore(row.documentId!, 1, 3, context);
  expect((await memory.service.exportBundle(context)).documents[0]?.revisions).toHaveLength(4);
});
