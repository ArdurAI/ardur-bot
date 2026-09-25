import { Readable } from "node:stream";
import type { HomeArchiveFile } from "@ardurbot/adapter-kit";
import type { Actor, ExportManifest } from "@ardurbot/contracts";
import { AccountExportSchema } from "@ardurbot/contracts";
import { createRepos, getUserPreferences } from "@ardurbot/db";
import type { Context, Hono } from "hono";
import { archiveFile, gzipArchive } from "./export-archive.js";
import { memoryContext } from "./memory-routes.js";
import type { RouterDeps } from "./router.js";
import { loadAllMessages } from "./thread-message-pages.js";
import { uploadedFileSelect, uploadedFilesWhere } from "./uploaded-files.js";

export type ExportDeps = Pick<
  RouterDeps,
  "prisma" | "memory" | "memoryDocuments" | "home" | "artifacts"
> & {
  exportLearning: (actor: Actor, botId: string) => Promise<NonNullable<ExportManifest["learning"]>>;
};

export async function exportBotData(
  deps: ExportDeps,
  actor: Actor,
  botId: string,
  archive: ExportFiles = exportFiles(),
): Promise<ExportManifest> {
  const bot = await createRepos(deps.prisma).getBot(actor, botId);
  const context = { ...memoryContext(actor), operationId: "export", traceId: "export" };
  const [memory, routines, history] = await Promise.all([
    deps.memory.read({ scope: "bot", botId }, context),
    deps.prisma.routine.findMany({
      where: { botId, spaceId: actor.spaceId, userId: actor.userId },
    }),
    bot.thread ? loadAllMessages(deps.prisma, bot.thread.id, 500) : [],
  ]);
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    bot: {
      name: bot.name,
      title: bot.title,
      description: bot.description,
      instructions: bot.instructions,
    },
    learning: await deps.exportLearning(actor, botId),
    memory: memory.documents.map(({ path, content }) => ({ path, content })),
    routines: routines.map(({ name, prompt, crons, timezone }) => ({
      name,
      prompt,
      crons,
      timezone,
    })),
    history,
    home: bot.computer ? registerHome(archive, bot.computer.homeKey, actor) : null,
  };
}

/** Select public data explicitly. Credentials, sessions, provider tokens and host pairing stay out. */
export async function exportAccountData(deps: ExportDeps, actor: Actor, archive = exportFiles()) {
  const user = await deps.prisma.user.findUniqueOrThrow({
    where: { id: actor.userId },
    select: { name: true, email: true, avatarStyle: true, createdAt: true },
  });
  const memberships = await deps.prisma.spaceMember.findMany({
    where: { userId: actor.userId },
    select: { space: { select: { id: true, name: true } } },
  });
  const spaces = [];
  for (const { space } of memberships) {
    const access = { ...actor, spaceId: space.id };
    const own = { spaceId: space.id, userId: actor.userId };
    const bots = await deps.prisma.bot.findMany({
      where: own,
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const exportedBots = [];
    for (const bot of bots) exportedBots.push(await exportBotData(deps, access, bot.id, archive));
    const rows = await deps.prisma.artifact.findMany({
      where: { ...uploadedFilesWhere(actor.userId), spaceId: space.id },
      select: { ...uploadedFileSelect, storageKey: true },
    });
    const uploads = [];
    for (const { storageKey, ...row } of rows) {
      const archivePath = `uploads/${archive.uploads.size + 1}`;
      archive.uploads.set(archivePath, { storageKey, actor: access });
      uploads.push({
        ...row,
        createdAt: row.createdAt.toISOString(),
        archivePath,
      });
    }
    const threads = await deps.prisma.thread.findMany({
      where: own,
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const conversations = [];
    for (const thread of threads)
      conversations.push({
        id: thread.id,
        messages: await loadAllMessages(deps.prisma, thread.id, 500),
      });
    spaces.push({
      ...space,
      bots: exportedBots,
      uploads,
      conversations,
      memory: deps.memoryDocuments
        ? await deps.memoryDocuments.exportBundle(memoryContext(access))
        : null,
      usage: await deps.prisma.usageRecord.findMany({
        where: own,
        select: {
          botId: true,
          runId: true,
          provider: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          cost: true,
          createdAt: true,
        },
      }),
      feedback: await deps.prisma.feedback.findMany({
        where: { spaceId: space.id, actorId: actor.userId },
        select: { messageId: true, rating: true, reason: true, createdAt: true, retractedAt: true },
      }),
      learningConsent: await deps.prisma.learningGrant.findMany({
        where: own,
        select: {
          category: true,
          scope: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
          maxPerDay: true,
        },
      }),
    });
  }
  // Normalize dates at the JSON boundary, before the RPC output validator.
  return AccountExportSchema.parse({
    version: 2,
    exportedAt: new Date().toISOString(),
    account: { ...user, createdAt: user.createdAt.toISOString() },
    preferences: await getUserPreferences(deps.prisma, actor.userId),
    spaces: JSON.parse(JSON.stringify(spaces)),
  });
}

type ExportFiles = {
  homes: Map<string, { path: string; actor: Actor }>;
  uploads: Map<string, { storageKey: string; actor: Actor }>;
};
function exportFiles(): ExportFiles {
  return { homes: new Map(), uploads: new Map() };
}
function registerHome(archive: ExportFiles, key: string, actor: Actor) {
  if (!archive.homes.has(key))
    archive.homes.set(key, { path: `homes/${archive.homes.size + 1}`, actor });
  return archive.homes.get(key)!.path;
}

export function exportExclusion(path: string): string | null {
  const parts = path.split("/");
  if (
    parts.some((part) => [".browser-profiles", ".mozilla"].includes(part)) ||
    /(^|\/)\.config\/(chromium|google-chrome|BraveSoftware|microsoft-edge)(\/|$)/.test(path)
  )
    return "Browser profile data";
  if (
    parts.some((part) =>
      [".cache", "node_modules", "__pycache__", ".npm", ".pnpm-store", ".venv"].includes(part),
    ) ||
    /(^|\/)\.yarn\/(cache|unplugged)(\/|$)/.test(path)
  )
    return "Regenerable cache or dependencies";
  return null;
}

export async function exportArchive(
  deps: ExportDeps,
  actor: Actor,
  botId?: string,
  signal?: AbortSignal,
) {
  const files = exportFiles();
  const data = botId
    ? await exportBotData(deps, actor, botId, files)
    : await exportAccountData(deps, actor, files);
  async function* entries(): AsyncGenerator<HomeArchiveFile> {
    const omitted = new Map<string, { path: string; reason: string }>();
    for (const [key, home] of files.homes) {
      const context = { ...memoryContext(home.actor), ...(signal ? { signal } : {}) };
      const exclude = (path: string) => {
        const reason = exportExclusion(path);
        if (reason) omitted.set(`${home.path}/${path}`, { path: `${home.path}/${path}`, reason });
        return Boolean(reason);
      };
      if (deps.home.streamHome) {
        for await (const file of deps.home.streamHome(key, context, exclude))
          yield { ...file, path: `${home.path}/${file.path}` };
      } else {
        for await (const file of deps.home.exportHome(key, context)) {
          if (!exclude(file.path))
            yield {
              ...file,
              path: `${home.path}/${file.path}`,
              size: file.content.byteLength,
              content: (async function* () {
                yield file.content;
              })(),
            };
        }
      }
    }
    for (const [path, upload] of files.uploads) {
      const content = await deps.artifacts.get(upload.storageKey, memoryContext(upload.actor));
      yield {
        path,
        size: content.byteLength,
        content: (async function* () {
          yield content;
        })(),
      };
    }
    yield archiveFile("manifest.json", { ...data, omitted: [...omitted.values()] });
  }
  return gzipArchive(entries(), signal);
}

export function exportDownload(actor: Actor, botId?: string) {
  const query = new URLSearchParams({ spaceId: actor.spaceId, ...(botId ? { botId } : {}) });
  return { path: `/api/exports/${botId ? "bot" : "account"}?${query}` };
}

export function mountExportRoutes(
  app: Hono,
  deps: ExportDeps,
  authenticate: (c: Context) => Promise<Actor | null>,
) {
  app.get("/api/exports/:kind", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const kind = c.req.param("kind");
    const botId = c.req.query("botId");
    if (!["account", "bot"].includes(kind) || (kind === "bot" && !botId))
      return c.json({ error: "Invalid export request." }, 400);
    const stream = await exportArchive(
      deps,
      actor,
      kind === "bot" ? botId : undefined,
      c.req.raw.signal,
    );
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${kind}-v2.tar.gz"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
