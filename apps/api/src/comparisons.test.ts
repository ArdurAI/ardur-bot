import type { ComparisonDeps } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { ComparisonExportSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { createComparisons } from "./comparisons.js";

it("requires membership before every comparison read, start, merge, preview and export", async () => {
  const findUnique = vi.fn(async () => null);
  const resolvePin = vi.fn();
  const api = createComparisons({
    prisma: { spaceMember: { findUnique } } as unknown as PrismaClient,
    resolvePin,
  } as ComparisonDeps);
  const actor = { spaceId: "foreign", userId: "owner" } as Actor;
  for (const call of [
    () => api.list(actor),
    () => api.get(actor, "id"),
    () => api.export(actor, "id"),
    () => api.preview(actor, {} as never),
    () => api.create(actor, {} as never),
    () => api.merge(actor, {} as never),
    () => api.previewMerge(actor, { id: "id", botId: "bot" }),
  ])
    await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(resolvePin).not.toHaveBeenCalled();
});
it("versions provenance exports and requires the complete frozen comparison shape", () => {
  expect(
    ComparisonExportSchema.safeParse({
      format: "ardurbot.comparison",
      version: 1,
      exportedAt: new Date().toISOString(),
      comparison: { results: [] },
    }).success,
  ).toBe(false);
});
