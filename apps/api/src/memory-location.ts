import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  authenticatedMemoryAccess,
  lockMemorySpace,
  selectDocumentStore,
  toStringRecord,
} from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { assertMemorySafe, bundleHash, previewImport, requireImportReady } from "@ardurbot/memory";
import { ORPCError } from "@orpc/server";
import { requireSpaceOwner, serializeSpaceMemoryConfig } from "./memory-provider-config.js";

export interface MemoryLocationInput {
  location: "postgres" | "obsidian";
  folder?: string;
  expectedGeneration: number;
  expectedHash?: string;
}
export async function changeMemoryLocation(
  deps: { prisma: PrismaClient; dataDir: string },
  actor: Actor,
  input: MemoryLocationInput,
) {
  await requireSpaceOwner(deps.prisma, actor);
  if (input.location === "obsidian" && !actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
  assertMemorySafe(input.folder ?? "");
  return deps.prisma.$transaction(
    async (tx) => {
      await lockMemorySpace(tx, actor.spaceId);
      const existing = await tx.spaceMemoryConfig.findUnique({ where: { spaceId: actor.spaceId } });
      if ((existing?.generation ?? 0) !== input.expectedGeneration)
        throw new ORPCError("CONFLICT", {
          message: "The memory location changed. Preview it again.",
        });
      const previousSettings = toStringRecord(existing?.documentSettings);
      if (existing?.documentStore === "obsidian" && previousSettings.ownerUserId !== actor.userId)
        throw new ORPCError("FORBIDDEN");
      const folder = input.folder?.trim();
      if (input.location === "obsidian") {
        if (!folder || !path.isAbsolute(folder) || path.parse(folder).root === folder)
          throw new ORPCError("BAD_REQUEST", {
            message: "Choose an empty dedicated memory folder.",
          });
        const info = await lstat(folder);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new ORPCError("BAD_REQUEST", {
            message: "Choose a folder without symbolic links.",
          });
        const entries = await readdir(folder);
        if (entries.length && !entries.includes(".ardur-memory.json"))
          throw new ORPCError("BAD_REQUEST", {
            message: "Choose an empty dedicated memory folder.",
          });
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`memory-folder:${folder}`}, 0))`;
        const registered = await tx.spaceMemoryConfig.findFirst({
          where: {
            spaceId: { not: actor.spaceId },
            documentStore: "obsidian",
            documentSettings: { path: ["folder"], equals: folder },
          },
        });
        if (registered)
          throw new ORPCError("CONFLICT", {
            message: "This folder belongs to another space. Choose an empty folder.",
          });
      }
      const context = {
        spaceId: actor.spaceId,
        userId: actor.userId,
        operationId: "memory-location",
        traceId: "memory-location",
        signal: new AbortController().signal,
      };
      const access = await authenticatedMemoryAccess(tx, context);
      const source = await selectDocumentStore(tx, existing, deps.dataDir);
      const documentSettings =
        input.location === "obsidian"
          ? { folder: folder!, ownerUserId: actor.userId, spaceId: actor.spaceId }
          : {};
      const target = await selectDocumentStore(
        tx,
        { documentStore: input.location, documentSettings },
        deps.dataDir,
      );
      const bundle = await source.exportBundle(access);
      const preview = previewImport(bundle, await target.exportBundle(access), access).preview;
      const hash = bundleHash(bundle);
      if (input.expectedHash === undefined)
        return { ...preview, hash, generation: existing?.generation ?? 0, config: null };
      requireImportReady({ ...preview, hash }, input.expectedHash);
      await target.importBundle(
        bundle,
        { status: "delivered", generation: (existing?.generation ?? 0) + 1, provider: null },
        access,
      );
      // Re-export verifies documents, history, timestamps and hashes before the atomic pointer switch.
      const copied = await target.exportBundle(access);
      const copiedIds = new Set(bundle.documents.map((doc) => doc.id));
      const verified = {
        version: 1 as const,
        documents: copied.documents
          .filter((doc) => copiedIds.has(doc.id))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
      const expected = {
        ...bundle,
        documents: [...bundle.documents].sort((a, b) => a.id.localeCompare(b.id)),
      };
      if (bundleHash(verified) !== bundleHash(expected))
        throw new ORPCError("CONFLICT", {
          message: "Memory verification failed. The previous location is still active.",
        });
      const next = await tx.spaceMemoryConfig.upsert({
        where: { spaceId: actor.spaceId },
        create: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          provider: "builtin",
          settings: {},
          documentStore: input.location,
          documentSettings,
          generation: 1,
        },
        update: {
          provider: "builtin",
          settings: {},
          secretId: null,
          documentStore: input.location,
          documentSettings,
          generation: { increment: 1 },
        },
      });
      return {
        ...preview,
        hash,
        generation: next.generation,
        config: serializeSpaceMemoryConfig(next),
      };
    },
    { timeout: 60_000 },
  );
}
