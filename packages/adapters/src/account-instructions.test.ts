import { redactSecrets } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { loadAccountInstructionContext } from "./account-instructions.js";

it("resumes a bounded input after redaction expands the saved snapshot", async () => {
  const context = {
    displayName: redactSecrets("x".repeat(60), ["x"]),
    instructions: redactSecrets("x".repeat(4000), ["x"]),
    workType: "",
    revision: 1,
    actorId: "owner",
    origin: "human-settings",
  };
  expect(context.instructions.length).toBeGreaterThan(4000);
  await expect(
    loadAccountInstructionContext({} as PrismaClient, {
      userId: "owner",
      spaceId: "space",
      accountInstructionContext: context,
    }),
  ).resolves.toEqual(context);
});

it("loads account context from the run's user and space and retains that revision on resume", async () => {
  const prisma = {
    user: {
      findUniqueOrThrow: vi.fn(async () => ({ displayName: "Captain", workType: "research" })),
    },
    space: {
      findUniqueOrThrow: vi.fn(async () => ({
        botInstructions: "Use short paragraphs.",
        botInstructionsAuthorId: "owner",
        botInstructionsRevision: 4,
      })),
    },
  };
  const run = { userId: "member", spaceId: "space" };
  const result = await loadAccountInstructionContext(prisma as unknown as PrismaClient, run);
  expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "member" } }),
  );
  expect(prisma.space.findUniqueOrThrow).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "space" } }),
  );
  expect(result).toMatchObject({ actorId: "owner", origin: "human-settings", revision: 4 });
  prisma.space.findUniqueOrThrow.mockRejectedValue(new Error("must not reread on resume"));
  expect(
    await loadAccountInstructionContext(prisma as unknown as PrismaClient, {
      ...run,
      accountInstructionContext: result,
    }),
  ).toEqual(result);
});
