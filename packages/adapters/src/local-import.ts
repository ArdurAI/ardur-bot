import { createHash, randomUUID } from "node:crypto";
import { MemoryConflictError } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import type {
  ImportedProvenance,
  LocalImportAction,
  LocalImportCategory,
  LocalImportFailure,
  LocalImportManifest,
  LocalImportRead,
  LocalImportResponse,
  LocalImportResult,
  LocalImportStop,
  LocalImportTool,
} from "@ardurbot/contracts/local-import";
import {
  LOCAL_IMPORT_FAILURES,
  LOCAL_IMPORT_TOOL_NAMES,
  LocalImportManifestSchema,
  LocalImportReadSchema,
  LocalImportRootsSchema,
  LocalImportSelectionSchema,
  LocalImportStatusSchema,
} from "@ardurbot/contracts/local-import";
import { RuntimePinError } from "@ardurbot/contracts/runtime-pins";
import { buildSkillMd, parseSkillMd } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { IsolationError, Prisma, withTransactionRetry } from "@ardurbot/db";
import { HostClient } from "@ardurbot/host-runtime/host-client";
import type { LocalImportScanner } from "@ardurbot/host-runtime/import/scanner";
import {
  createLocalImportScanner,
  LocalImportRescanError,
} from "@ardurbot/host-runtime/import/scanner";
import { getLogger } from "@ardurbot/logging";
import type { MemoryOperationContext, MemoryService } from "@ardurbot/memory";
import { MemoryRedactionError } from "@ardurbot/memory";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";

export type ImportOwner = Pick<Actor, "spaceId" | "userId">;
/** The paired host could not be reached or stopped answering. */
export class LocalImportHostError extends Error {
  constructor(options?: ErrorOptions) {
    super("The paired host did not answer the import request.", options);
    this.name = "LocalImportHostError";
  }
}
/** Only these stop a whole run; any other failure belongs to the item that caused it. */
export function localImportStop(error: unknown): LocalImportStop | undefined {
  if (error instanceof LocalImportHostError) return "host";
  if (error instanceof LocalImportRescanError) return "rescan";
  if (error instanceof IsolationError) return "failed";
  return undefined;
}
export interface LocalImportTransport {
  scan(
    owner: ImportOwner,
    roots: Partial<Record<LocalImportTool, string>>,
  ): Promise<LocalImportManifest>;
  read(owner: ImportOwner, scanId: string, itemId: string): Promise<LocalImportRead>;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const counts = (): LocalImportResult => ({
  created: 0,
  updated: 0,
  unchanged: 0,
  removed: 0,
  skipped: 0,
  conflicts: 0,
  failed: 0,
});
const contextFor = (
  owner: ImportOwner,
  imported?: ImportedProvenance,
  tx?: Prisma.TransactionClient,
): MemoryOperationContext => ({
  ...owner,
  operationId: "local-import",
  traceId: "local-import",
  signal: AbortSignal.timeout(60_000),
  ...(imported ? { imported } : {}),
  ...(tx ? { databaseTransaction: tx } : {}),
});

export async function assertLocalImportOwner(
  prisma: PrismaClient | Prisma.TransactionClient,
  owner: ImportOwner,
) {
  const [deployment, member] = await Promise.all([
    prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
    prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: owner.spaceId, userId: owner.userId } },
    }),
  ]);
  if (deployment?.ownerUserId !== owner.userId || member?.role !== "owner")
    throw new IsolationError();
}

export class LocalImportService {
  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      documents: MemoryService;
      transport?: LocalImportTransport;
    },
  ) {}
  private async config(owner: ImportOwner) {
    await assertLocalImportOwner(this.deps.prisma, owner);
    return this.deps.prisma.localImportConfig.upsert({
      where: { spaceId_userId: owner },
      create: owner,
      update: {},
    });
  }
  async status(owner: ImportOwner) {
    const config = await this.config(owner);
    const records = await this.deps.prisma.localImportRecord.findMany({
      where: { configId: config.id, removedAt: null },
    });
    const tools = [...new Set(records.map((record) => record.tool))];
    return LocalImportStatusSchema.parse({
      manifest: config.manifest ? LocalImportManifestSchema.parse(config.manifest) : null,
      roots: LocalImportRootsSchema.parse(config.roots),
      autoImport: config.autoImport,
      selection: LocalImportSelectionSchema.parse(config.selection),
      importedAt: config.importedAt?.toISOString() ?? null,
      imported: tools.map((tool) => ({
        tool,
        count: records.filter((record) => record.tool === tool).length,
      })),
    });
  }
  async configure(
    owner: ImportOwner,
    input: {
      autoImport?: boolean;
      roots?: Partial<Record<LocalImportTool, string>>;
      selection?: Partial<Record<LocalImportTool, LocalImportCategory[]>>;
    },
  ) {
    const config = await this.config(owner);
    if (input.autoImport && !config.importedAt)
      throw new Error("Import some items before enabling automatic import.");
    const manifest = config.manifest ? LocalImportManifestSchema.parse(config.manifest) : null;
    if (input.roots)
      for (const [tool, root] of Object.entries(input.roots)) {
        if (!manifest?.sources.some((source) => source.tool === tool && source.defaultMissing))
          throw new Error("A custom folder is available only when the default is missing.");
        if (!root || root.includes("\0") || root.split(/[/\\]/u).includes(".."))
          throw new Error("Choose a folder inside the owner's home.");
      }
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`local-import:${config.id}`}, 0))`;
      await assertLocalImportOwner(tx, owner);
      await tx.localImportConfig.update({
        where: { id: config.id },
        data: {
          ...(input.autoImport !== undefined ? { autoImport: input.autoImport } : {}),
          ...(input.selection
            ? { selection: LocalImportSelectionSchema.parse(input.selection) }
            : {}),
          ...(input.roots ? { roots: input.roots, manifest: Prisma.DbNull } : {}),
        },
      });
    });
    return this.status(owner);
  }
  private manifest(config: { manifest: unknown }, scanId: string) {
    const manifest = LocalImportManifestSchema.parse(config.manifest);
    if (manifest.scanId !== scanId)
      throw new LocalImportRescanError("Re-scan this computer before importing.");
    return manifest;
  }
  private async read(owner: ImportOwner, manifest: LocalImportManifest, itemId: string) {
    const expected = manifest.items.find((item) => item.id === itemId && item.importable);
    if (!expected) throw new IsolationError();
    if (!this.deps.transport) throw new Error("The import worker is unavailable.");
    const value = LocalImportReadSchema.parse(
      await this.deps.transport.read(owner, manifest.scanId, itemId),
    );
    if (
      JSON.stringify(value.item) !== JSON.stringify(expected) ||
      hash(value.content) !== expected.contentHash
    )
      throw new LocalImportRescanError("The source changed. Re-scan this computer.");
    if (value.server && value.content !== JSON.stringify(value.server, null, 2))
      throw new Error("Server preview does not match its definition.");
    return value;
  }
  async run(
    owner: ImportOwner,
    action: LocalImportAction,
    automatic = false,
  ): Promise<LocalImportResponse> {
    const config = await this.config(owner);
    if (action.action === "scan") {
      if (!this.deps.transport) throw new Error("The import worker is unavailable.");
      const manifest = LocalImportManifestSchema.parse(
        await this.deps.transport.scan(owner, LocalImportRootsSchema.parse(config.roots)),
      );
      await assertLocalImportOwner(this.deps.prisma, owner);
      await this.deps.prisma.localImportConfig.update({
        where: { id: config.id },
        data: { manifest },
      });
      return { manifest };
    }
    if (action.action === "undo") return { result: await this.undo(owner, config.id, action.tool) };
    const manifest = this.manifest(config, action.scanId);
    if (action.action === "preview")
      return { preview: await this.read(owner, manifest, action.itemId) };
    const result = counts();
    const failures: LocalImportFailure[] = [];
    let stopped: LocalImportStop | undefined;
    for (const item of manifest.items.filter(
      (item) =>
        action.categories.includes(item.category) &&
        (!action.tool || item.tool === action.tool) &&
        (!action.itemId || item.id === action.itemId),
    )) {
      if (!item.importable) {
        result.skipped++;
        continue;
      }
      const previous = await this.deps.prisma.localImportRecord.findUnique({
        where: {
          configId_tool_sourcePathHash: {
            configId: config.id,
            tool: item.tool,
            sourcePathHash: item.sourcePathHash,
          },
        },
      });
      if (previous?.contentHash === item.contentHash && (!previous.removedAt || automatic)) {
        result.unchanged++;
        continue;
      }
      try {
        const value = await this.read(owner, manifest, item.id);
        result[await this.importItem(owner, config.id, value, automatic)]++;
      } catch (error) {
        // Never log the item body; the path and error say which source to fix.
        getLogger().error("local-import item failed", error, {
          "import.tool": item.tool,
          "import.category": item.category,
          "import.path": item.relativePath,
        });
        const reason = localImportStop(error);
        if (reason) {
          stopped = reason;
          break;
        }
        result.failed++;
        if (failures.length < LOCAL_IMPORT_FAILURES)
          failures.push({
            itemId: item.id,
            tool: item.tool,
            category: item.category,
            relativePath: item.relativePath,
            reason: error instanceof MemoryRedactionError ? "credential" : "failed",
          });
      }
    }
    const selection = LocalImportSelectionSchema.parse(config.selection);
    if (!automatic && !action.itemId)
      for (const source of manifest.sources.filter(
        (source) => !action.tool || source.tool === action.tool,
      ))
        selection[source.tool] = action.categories;
    await this.deps.prisma.localImportConfig.update({
      where: { id: config.id },
      data: {
        ...(result.created + result.updated > 0 ? { importedAt: new Date() } : {}),
        ...(!automatic && !action.itemId ? { selection } : {}),
      },
    });
    // Items written before the stop stay imported and recorded above; the caller gets the
    // partial result and the failures found so far along with why the run stopped.
    return {
      result,
      ...(failures.length ? { failures } : {}),
      ...(stopped ? { stopped } : {}),
    };
  }
  private async importItem(
    owner: ImportOwner,
    configId: string,
    value: LocalImportRead,
    automatic: boolean,
  ): Promise<keyof LocalImportResult> {
    const { item } = value;
    const provenance: ImportedProvenance = {
      tool: item.tool,
      relativePath: item.relativePath,
      sourcePathHash: item.sourcePathHash,
      contentHash: item.contentHash,
      modifiedAt: item.modifiedAt,
      importedAt: new Date().toISOString(),
      kind: item.category,
      authorizesIntent: false,
    };
    const documents = this.deps.documents;
    let scheduled: Awaited<ReturnType<MemoryService["commit"]>> | undefined;
    const result = await withTransactionRetry(() =>
      this.deps.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`local-import:${configId}`}, 0))`;
          await assertLocalImportOwner(tx, owner);
          const config = await tx.localImportConfig.findUniqueOrThrow({ where: { id: configId } });
          if (automatic && !config.autoImport) return "skipped" as const;
          const where = {
            configId_tool_sourcePathHash: {
              configId,
              tool: item.tool,
              sourcePathHash: item.sourcePathHash,
            },
          };
          const prior = await tx.localImportRecord.findUnique({ where });
          const wasActive = Boolean(prior && !prior.removedAt);
          if (prior?.contentHash === item.contentHash && (!prior.removedAt || automatic))
            return "unchanged" as const;
          const context = contextFor(owner, provenance, tx);
          let targetId = prior?.targetId ?? randomUUID();
          let targetRevision = 1;
          let documentId: string | null = prior?.documentId ?? null;
          if (item.category === "servers") {
            const server = value.server;
            if (!server) return "skipped" as const;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${targetId}))`;
            const existing =
              prior && !prior.removedAt
                ? await tx.mcpServer.findFirst({ where: { id: targetId, ...owner } })
                : null;
            if (
              prior &&
              !prior.removedAt &&
              (!existing || existing.revision !== prior.targetRevision)
            )
              return "conflicts" as const;
            const stem =
              server.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/gu, "-")
                .replace(/^-|-$/gu, "")
                .slice(0, 50) || "server";
            let slug = existing?.slug ?? stem;
            if (!existing && (await tx.mcpServer.findFirst({ where: { ...owner, slug } })))
              slug = `${item.tool}-${stem}-${item.sourcePathHash.slice(0, 8)}`;
            const data = {
              ...owner,
              name: server.name,
              enabled: server.enabled,
              slug,
              description: `Imported from ${LOCAL_IMPORT_TOOL_NAMES[item.tool]}`,
              transport: server.transport,
              command: server.command ?? null,
              endpoint: server.endpoint ?? null,
              args: server.args,
              env: Object.fromEntries(server.envNames.map((key) => [key, true])),
              headers: Object.fromEntries(
                server.headerNames.map((key) => [key, server.headerEnv[key] ?? true]),
              ),
              imported: provenance,
            };
            const previousSecretId = existing?.secretId;
            const saved = existing
              ? await tx.mcpServer.update({
                  where: { id: existing.id },
                  data: { ...data, secretId: null, revision: { increment: 1 } },
                })
              : await tx.mcpServer.create({ data: { id: targetId, ...data } });
            if (existing) {
              await tx.mcpOAuthSession.deleteMany({ where: { serverId: existing.id, ...owner } });
              await tx.botMcpServer.updateMany({
                where: { serverId: existing.id, ...owner },
                data: { needsReview: true },
              });
              if (previousSecretId)
                await tx.secret.deleteMany({ where: { id: previousSecretId, ...owner } });
            }
            targetRevision = saved.revision;
          } else if (["instructions", "memories", "skills"].includes(item.category)) {
            // Exact duplicate memory bodies share one owned document; source records remain separate.
            const duplicate =
              (!prior || prior.removedAt) && item.category !== "skills"
                ? await tx.localImportRecord.findFirst({
                    where: {
                      configId,
                      category: item.category,
                      contentHash: item.contentHash,
                      removedAt: null,
                      documentId: { not: null },
                    },
                  })
                : null;
            const duplicateDoc = duplicate?.documentId
              ? await documents.read(duplicate.documentId, context)
              : null;
            if (
              duplicate &&
              duplicateDoc &&
              !duplicateDoc.deletedAt &&
              duplicateDoc.revision === duplicate.targetRevision
            ) {
              documentId = duplicate.documentId;
              targetId = duplicate.targetId;
              targetRevision = duplicate.targetRevision;
            } else {
              const head = prior?.documentId
                ? await documents.read(prior.documentId, context)
                : null;
              if (
                prior &&
                (!head ||
                  (head.revision === prior.targetRevision &&
                    ((!prior.removedAt && head.deletedAt) || (prior.removedAt && !head.deletedAt))))
              )
                return "conflicts" as const;
              // A changed source that shared a document splits off instead of changing another source.
              const shared =
                prior?.documentId &&
                (await tx.localImportRecord.findFirst({
                  where: {
                    configId,
                    documentId: prior.documentId,
                    removedAt: null,
                    id: { not: prior.id },
                  },
                }));
              if (shared && head?.revision !== prior?.targetRevision) return "conflicts" as const;
              let content = value.content;
              let skillName = "";
              let description = "";
              if (item.category === "skills") {
                const parsed = parseSkillMd(content);
                if ("error" in parsed) return "skipped" as const;
                skillName = parsed.name;
                description = parsed.description;
                const existingSkill = prior
                  ? await tx.agentSkill.findFirst({ where: { id: targetId, ...owner } })
                  : null;
                if (existingSkill) skillName = existingSkill.name;
                else {
                  const collision = await tx.agentSkill.findFirst({
                    where: { ...owner, name: { equals: skillName, mode: "insensitive" } },
                  });
                  if (
                    collision ||
                    BUILTIN_AGENT_SKILLS.some(
                      (skill) => skill.name.toLowerCase() === skillName.toLowerCase(),
                    )
                  ) {
                    skillName = `${item.tool}-${parsed.name}`.slice(0, 70);
                    if (
                      await tx.agentSkill.findFirst({
                        where: { ...owner, name: { equals: skillName, mode: "insensitive" } },
                      })
                    )
                      skillName += `-${item.sourcePathHash.slice(0, 8)}`;
                  }
                }
                content = buildSkillMd({ ...parsed, name: skillName });
              }
              const doc = await this.commitImportedDocument(
                {
                  ...(!shared && head ? { id: head.id } : {}),
                  scope: "user",
                  path:
                    !shared && head
                      ? head.path
                      : `${item.category === "skills" ? "skills" : `imported/${item.category}`}/${item.tool}-${item.sourcePathHash}${shared ? `-${item.contentHash}` : ""}.md`,
                  content,
                  expectedRevision: !shared && head ? prior!.targetRevision : 0,
                },
                context,
              );
              if (!doc) return "conflicts" as const;
              scheduled = doc;
              documentId = doc.id;
              targetRevision = doc.revision;
              if (item.category === "skills") {
                await tx.agentSkill.upsert({
                  where: { id: targetId },
                  create: {
                    id: targetId,
                    ...owner,
                    name: skillName,
                    description,
                    content: "",
                    documentId,
                    activeRevision: doc.revision,
                    source: "imported",
                    origin: "imported",
                    imported: provenance,
                  },
                  update: {
                    name: skillName,
                    description,
                    content: "",
                    documentId,
                    activeRevision: doc.revision,
                    imported: provenance,
                  },
                });
              } else targetId = doc.id;
            }
          } else return "skipped" as const;
          const data = {
            configId,
            tool: item.tool,
            category: item.category,
            relativePath: item.relativePath,
            sourcePathHash: item.sourcePathHash,
            contentHash: item.contentHash,
            modifiedAt: new Date(item.modifiedAt),
            importedAt: new Date(),
            targetId,
            targetRevision,
            documentId,
            removedAt: null,
          };
          await tx.localImportRecord.upsert({ where, create: data, update: data });
          return wasActive ? ("updated" as const) : ("created" as const);
        },
        { timeout: 60_000 },
      ),
    );
    if (scheduled) await documents.schedule(scheduled, contextFor(owner));
    return result;
  }

  private async commitImportedDocument(
    input: Parameters<MemoryService["commit"]>[0],
    context: MemoryOperationContext,
  ) {
    const documents = this.deps.documents;
    const source = context.imported;
    try {
      return await documents.commit(input, {
        ...context,
        imported: source ? { ...source, documentRevision: input.expectedRevision + 1 } : undefined,
      });
    } catch (error) {
      if (!(error instanceof MemoryConflictError)) throw error;
      // File-backed stores commit before the SQL receipt. Reuse that exact write on retry,
      // including after a restart, without adopting intervening edits, restores or another source.
      let head = input.id ? await documents.read(input.id, context) : null;
      if (!input.id) {
        let cursor: string | undefined;
        do {
          const page = await documents.list(
            { scope: "user", includeDeleted: true, cursor, limit: 100 },
            context,
          );
          head = page.items.find((doc) => doc.path === input.path) ?? null;
          cursor = page.nextCursor ?? undefined;
        } while (!head && cursor);
      }
      return head &&
        source &&
        !head.deletedAt &&
        head.revision === input.expectedRevision + 1 &&
        head.path === input.path &&
        head.content === input.content &&
        head.scopeKey.kind === "user" &&
        head.scopeKey.spaceId === context.spaceId &&
        head.scopeKey.userId === context.userId &&
        head.imported?.tool === source.tool &&
        head.imported.documentRevision === head.revision &&
        head.imported.sourcePathHash === source.sourcePathHash &&
        head.imported.contentHash === source.contentHash &&
        head.imported.kind === source.kind
        ? head
        : null;
    }
  }

  private async undo(owner: ImportOwner, configId: string, tool: LocalImportTool) {
    const result = counts();
    const rows = await this.deps.prisma.localImportRecord.findMany({
      where: { configId, tool, removedAt: null },
    });
    for (const row of rows) {
      let scheduled: Awaited<ReturnType<MemoryService["delete"]>> | undefined;
      const outcome = await this.deps.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`local-import:${configId}`}, 0))`;
          await assertLocalImportOwner(tx, owner);
          await tx.localImportConfig.update({
            where: { id: configId },
            data: { autoImport: false },
          });
          const current = await tx.localImportRecord.findUnique({ where: { id: row.id } });
          if (!current || current.removedAt) return "unchanged" as const;
          const shared = await tx.localImportRecord.findFirst({
            where: {
              configId,
              targetId: current.targetId,
              removedAt: null,
              id: { not: current.id },
            },
          });
          if (!shared) {
            if (current.documentId) {
              const head = await this.deps.documents.read(
                current.documentId,
                contextFor(owner, undefined, tx),
              );
              if (!head || head.deletedAt || head.revision !== current.targetRevision)
                return "conflicts" as const;
              scheduled = await this.deps.documents.delete(
                head.id,
                head.revision,
                contextFor(owner, undefined, tx),
              );
              // All removed aliases must point at this tombstone so a later import can restore it.
              await tx.localImportRecord.updateMany({
                where: {
                  configId,
                  documentId: current.documentId,
                  removedAt: { not: null },
                  targetRevision: head.revision,
                },
                data: { targetRevision: scheduled.revision },
              });
            } else {
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${current.targetId}))`;
              const server = await tx.mcpServer.findFirst({
                where: { id: current.targetId, ...owner, revision: current.targetRevision },
              });
              if (!server) return "conflicts" as const;
              const removed = await tx.mcpServer.deleteMany({
                where: { id: current.targetId, ...owner, revision: current.targetRevision },
              });
              if (!removed.count) return "conflicts" as const;
              if (server.secretId)
                await tx.secret.deleteMany({ where: { id: server.secretId, ...owner } });
            }
          }
          await tx.localImportRecord.update({
            where: { id: current.id },
            data: {
              removedAt: new Date(),
              ...(scheduled ? { targetRevision: scheduled.revision } : {}),
            },
          });
          return "removed" as const;
        },
        { timeout: 60_000 },
      );
      result[outcome]++;
      if (scheduled) await this.deps.documents.schedule(scheduled, contextFor(owner));
    }
    return result;
  }
  async refresh() {
    const due = await this.deps.prisma.localImportConfig.findMany({
      where: {
        autoImport: true,
        importedAt: { not: null },
        OR: [
          { lastRefreshAt: null },
          { lastRefreshAt: { lte: new Date(Date.now() - 60 * 60_000) } },
        ],
      },
    });
    for (const config of due) {
      const owner = { spaceId: config.spaceId, userId: config.userId };
      const claimed = await this.deps.prisma.localImportConfig.updateMany({
        where: { id: config.id, autoImport: true, lastRefreshAt: config.lastRefreshAt },
        data: { lastRefreshAt: new Date() },
      });
      if (!claimed.count) continue;
      await assertLocalImportOwner(this.deps.prisma, owner);
      const { manifest } = await this.run(owner, { action: "scan" }, true);
      for (const [tool, categories] of Object.entries(
        LocalImportSelectionSchema.parse(config.selection),
      )) {
        if (categories?.length)
          await this.run(
            owner,
            {
              action: "import",
              scanId: manifest!.scanId,
              tool: tool as LocalImportTool,
              categories,
            },
            true,
          );
      }
    }
  }
}

/** The worker owns discovery in source mode; packaged deployments use the paired host. */
export function createImportTransport(
  prisma: PrismaClient,
  options: { apiUrl: string; encryptionKey: string; packaged: boolean },
): LocalImportTransport {
  const local = new Map<string, LocalImportScanner>();
  const host = new HostClient(options);
  const scanner = async (owner: ImportOwner) => {
    const key = `${owner.spaceId}:${owner.userId}`;
    let value = local.get(key);
    if (!value) {
      if (local.size >= 16) throw new Error("Too many active import scans.");
      const registration = await prisma.hostRegistration.findUnique({ where: { id: "default" } });
      const roots = registration?.userId === owner.userId ? registration.hostRoots : [];
      value = await createLocalImportScanner(roots);
      local.set(key, value);
    }
    return value;
  };
  const remote = async (owner: ImportOwner, operation: Parameters<HostClient["request"]>[0]) => {
    let text = "";
    try {
      for await (const frame of host.request(operation, {
        ...owner,
        botId: "owner-import",
        runId: `import-${randomUUID()}`,
        signal: AbortSignal.timeout(120_000),
      })) {
        if (frame.channel !== "result" || typeof frame.data !== "string")
          throw new Error("Invalid host import response.");
        text += frame.data;
        if (Buffer.byteLength(text) > 8 * 1024 * 1024)
          throw new Error("Import manifest is too large.");
      }
    } catch (error) {
      // HostClient reports a lost, busy or failed host this way; other errors are ours.
      if (!(error instanceof RuntimePinError)) throw error;
      if (error.problem.code === "local-import-rescan")
        throw new LocalImportRescanError(error.problem.reason);
      if (error.problem.code === "local-import-item") throw new Error(error.problem.reason);
      throw new LocalImportHostError({ cause: error });
    }
    return JSON.parse(text) as unknown;
  };
  return {
    scan: async (owner, roots) =>
      options.packaged
        ? LocalImportManifestSchema.parse(await remote(owner, { op: "import.scan", roots }))
        : (await scanner(owner)).scan(roots),
    read: async (owner, scanId, itemId) =>
      options.packaged
        ? LocalImportReadSchema.parse(await remote(owner, { op: "import.read", scanId, itemId }))
        : (await scanner(owner)).read(scanId, itemId),
  };
}
