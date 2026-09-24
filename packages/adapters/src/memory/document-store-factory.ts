import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { MemoryDocumentStore } from "@ardurbot/adapter-kit";
import type { Prisma } from "@ardurbot/db";
import { PostgresDocumentStore } from "@ardurbot/memory";
import type { EncryptedSecretStore } from "../secrets.js";
import { configuredGitStore } from "./git-config.js";
import { MarkdownFiles } from "./markdown-files.js";
import { ObsidianDocumentStore, VaultWithPrivateDocuments } from "./obsidian-store.js";

/** Document destination selection is independent of the semantic provider adapter. */
export async function selectDocumentStore(
  tx: Prisma.TransactionClient,
  config: { documentStore: string; documentSettings: unknown; secretId?: string | null } | null,
  dataDir: string,
  secrets?: Pick<EncryptedSecretStore, "load">,
): Promise<MemoryDocumentStore> {
  const postgres = new PostgresDocumentStore(tx);
  if (!config || !config.documentStore || config.documentStore === "postgres") return postgres;
  if (config.documentStore === "git")
    return new VaultWithPrivateDocuments(
      await configuredGitStore(tx, config, dataDir, secrets),
      postgres,
      null,
    );
  if (config.documentStore !== "obsidian") throw new Error("This memory location is unavailable.");
  const settings = config.documentSettings as Record<string, unknown> | null;
  if (
    !settings ||
    typeof settings.folder !== "string" ||
    !settings.folder ||
    typeof settings.ownerUserId !== "string" ||
    !settings.ownerUserId ||
    typeof settings.spaceId !== "string" ||
    !settings.spaceId
  )
    throw new Error("Register a memory folder first.");
  const quarantineRoot = path.resolve(dataDir, "memory-quarantine");
  await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
  // Canonical app storage may live under a platform alias (e.g. macOS /var); the user folder may not.
  const quarantine = new MarkdownFiles(await realpath(quarantineRoot));
  const vault = new ObsidianDocumentStore({
    files: new MarkdownFiles(settings.folder),
    quarantine,
    spaceId: settings.spaceId,
    ownerUserId: settings.ownerUserId,
    exclusive: (action) => action(),
  });
  return new VaultWithPrivateDocuments(vault, postgres, settings.ownerUserId);
}
