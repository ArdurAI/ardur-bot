import type { Actor, ExportManifest } from "@ardurbot/contracts";
import { AccountExportSchema } from "@ardurbot/contracts";
import { createRepos, getUserPreferences } from "@ardurbot/db";
import { memoryContext } from "./memory-routes.js";
import type { RouterDeps } from "./router.js";
import { loadAllMessages } from "./thread-message-pages.js";
import { uploadedFileSelect, uploadedFilesWhere } from "./uploaded-files.js";

type ExportDeps = Pick<
  RouterDeps,
  "prisma" | "memory" | "memoryDocuments" | "home" | "artifacts"
> & {
  exportLearning: (actor: Actor, botId: string) => Promise<NonNullable<ExportManifest["learning"]>>;
};

export async function exportBotData(
  deps: ExportDeps,
  actor: Actor,
  botId: string,
  options: { includeArchived?: boolean } = {},
): Promise<ExportManifest> {
  const bot = await createRepos(deps.prisma).getBot(actor, botId, options);
  const context = { ...memoryContext(actor), operationId: "export", traceId: "export" };
  const [memory, routines, history, files] = await Promise.all([
    deps.memory.read({ scope: "bot", botId }, context),
    deps.prisma.routine.findMany({
      where: { botId, spaceId: actor.spaceId, userId: actor.userId },
    }),
    bot.thread ? loadAllMessages(deps.prisma, bot.thread.id, 500) : [],
    (async () => {
      const files: Array<{ path: string; content: string }> = [];
      if (bot.computer)
        for await (const file of deps.home.exportHome(bot.computer.homeKey, context))
          files.push({ path: file.path, content: new TextDecoder().decode(file.content) });
      return files;
    })(),
  ]);
  return {
    version: 1,
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
    files,
  };
}

/** Select public data explicitly. Credentials, sessions, provider tokens and host pairing stay out. */
export async function exportAccountData(deps: ExportDeps, actor: Actor) {
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
    for (const bot of bots)
      exportedBots.push(await exportBotData(deps, access, bot.id, { includeArchived: true }));
    const rows = await deps.prisma.artifact.findMany({
      where: { ...uploadedFilesWhere(actor.userId), spaceId: space.id },
      select: { ...uploadedFileSelect, storageKey: true },
    });
    const uploads = [];
    for (const { storageKey, ...row } of rows)
      uploads.push({
        ...row,
        createdAt: row.createdAt.toISOString(),
        contentBase64: Buffer.from(
          await deps.artifacts.get(storageKey, memoryContext(access)),
        ).toString("base64"),
      });
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
    version: 1,
    exportedAt: new Date().toISOString(),
    account: { ...user, createdAt: user.createdAt.toISOString() },
    preferences: await getUserPreferences(deps.prisma, actor.userId),
    spaces: JSON.parse(JSON.stringify(spaces)),
  });
}
