import { createHash } from "node:crypto";
import type { SecretStore } from "@ardurbot/adapter-kit";
import type { EncryptedSecretStore } from "@ardurbot/adapters";
import {
  authenticatedMemoryAccess,
  configuredGitStore,
  lockMemorySpace,
  memoryGitAllowedHosts,
  memoryGitMachine,
  selectDocumentStore,
  validateGitBranch,
  validateGitRemote,
} from "@ardurbot/adapters";
import type { Actor, MemoryBundle } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import {
  bundleHash,
  previewImport,
  requireImportReady,
  samePortableRevision,
} from "@ardurbot/memory";
import { ORPCError } from "@orpc/server";
import { requireSpaceOwner, serializeSpaceMemoryConfig } from "./memory-provider-config.js";
import { memoryContext } from "./memory-routes.js";

export interface GitMemoryLocationInput {
  url: string;
  branch: string;
  mode: "publish" | "propose";
  credential?: { kind: "token" | "ssh"; value: string };
  connectionId?: string;
  expectedGeneration: number;
  expectedHash?: string;
}
function verifiedCopy(original: MemoryBundle, copied: MemoryBundle): boolean {
  return original.documents.every((document) => {
    const copy = copied.documents.find((entry) => entry.id === document.id);
    return (
      copy &&
      copy.revisions.length === document.revisions.length &&
      document.revisions.every((revision, index) =>
        samePortableRevision(revision, copy.revisions[index]!),
      )
    );
  });
}
export async function changeGitMemoryLocation(
  deps: {
    prisma: PrismaClient;
    secrets: Pick<SecretStore, "put"> & Pick<EncryptedSecretStore, "load">;
    dataDir: string;
  },
  actor: Actor,
  input: GitMemoryLocationInput,
) {
  await requireSpaceOwner(deps.prisma, actor);
  const remote = validateGitRemote(input.url, memoryGitAllowedHosts());
  const branch = validateGitBranch(input.branch);
  if (input.credential && (input.credential.kind === "token") !== (remote.protocol === "https"))
    throw new Error("Choose a token for HTTPS or a deploy key for SSH.");
  const context = memoryContext(actor);
  const stored = input.credential
    ? await deps.secrets.put(
        JSON.stringify({ ...input.credential, repositoryUrl: remote.url }),
        context,
      )
    : null;
  const machineId = await memoryGitMachine(deps.dataDir);
  return deps.prisma.$transaction(
    async (tx) => {
      await lockMemorySpace(tx, actor.spaceId);
      const current = await tx.spaceMemoryConfig.findUnique({ where: { spaceId: actor.spaceId } });
      if ((current?.generation ?? 0) !== input.expectedGeneration)
        throw new ORPCError("CONFLICT", {
          message: "The memory location changed. Preview it again.",
        });
      const previousSettings = current?.documentSettings as Record<string, string> | undefined;
      if (current?.documentStore === "obsidian" && previousSettings?.ownerUserId !== actor.userId)
        throw new ORPCError("FORBIDDEN");
      let secretId =
        input.connectionId ??
        (current?.documentStore === "git" && previousSettings?.url === remote.url
          ? current.secretId
          : null);
      if (stored) {
        const record = await tx.secret.create({
          data: {
            id: stored.id,
            ciphertext: stored.ciphertext,
            kind: "memory-git",
            spaceId: actor.spaceId,
            userId: actor.userId,
          },
        });
        secretId = record.id;
      }
      if (!secretId) throw new Error("Paste a repository token or deploy key to connect.");
      const record = await tx.secret.findFirst({
        where: { id: secretId, spaceId: actor.spaceId, userId: actor.userId, kind: "memory-git" },
      });
      if (!record) throw new ORPCError("FORBIDDEN");
      const credential = JSON.parse(deps.secrets.load(record.ciphertext, record.id)) as {
        repositoryUrl?: string;
      };
      if (credential.repositoryUrl !== remote.url) throw new ORPCError("FORBIDDEN");
      const documentSettings = {
        url: remote.url,
        host: remote.host,
        branch,
        mode: input.mode,
        machineId,
        spaceId: actor.spaceId,
      };
      const targetConfig = { documentStore: "git", documentSettings, secretId };
      const targetGit = await configuredGitStore(tx, targetConfig, deps.dataDir, deps.secrets);
      const access = await authenticatedMemoryAccess(tx, context);
      access.displayName = (
        await tx.user.findUnique({ where: { id: actor.userId }, select: { name: true } })
      )?.name;
      await targetGit.startSession(access);
      const state = await targetGit.syncState(access);
      if (state.status === "last-copy" || state.status === "quarantined")
        throw new Error("Could not fetch the repository. Check its URL and access, then retry.");
      const source = await selectDocumentStore(tx, current, deps.dataDir, deps.secrets);
      const target = await selectDocumentStore(tx, targetConfig, deps.dataDir, deps.secrets);
      const bundle = await source.exportBundle(access);
      const destination = await target.exportBundle(access);
      const preview = previewImport(bundle, destination, access).preview;
      const hash = createHash("sha256")
        .update(
          JSON.stringify({
            source: bundleHash(bundle),
            target: bundleHash(destination),
            documentSettings,
            secretId,
            generation: input.expectedGeneration,
          }),
        )
        .digest("hex");
      if (input.expectedHash === undefined)
        return {
          ...preview,
          hash,
          connectionId: secretId,
          generation: current?.generation ?? 0,
          config: null,
        };
      requireImportReady({ ...preview, hash }, input.expectedHash);
      const generation = (current?.generation ?? 0) + 1;
      await target.importBundle(
        bundle,
        { status: "delivered", provider: null, generation },
        access,
      );
      if (!verifiedCopy(bundle, await target.exportBundle(access)))
        throw new Error("Memory verification failed. The previous location is still active.");
      const next = await tx.spaceMemoryConfig.upsert({
        where: { spaceId: actor.spaceId },
        create: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          provider: "builtin",
          settings: {},
          generation,
          ...targetConfig,
        },
        update: { provider: "builtin", settings: {}, generation, ...targetConfig },
      });
      // The durable Git outbox is picked up by reconciliation even if enqueue after this transaction fails.
      return {
        ...preview,
        hash,
        connectionId: secretId,
        generation,
        config: serializeSpaceMemoryConfig(next),
      };
    },
    { timeout: 60_000 },
  );
}
