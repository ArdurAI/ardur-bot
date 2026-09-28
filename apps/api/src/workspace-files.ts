import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import { teamBotWorkspaceDirectory, toComputerRef, workspacePath } from "@ardurbot/adapters";
import type { Actor, WorkspaceContext } from "@ardurbot/contracts";
import { IDE_FILE_BYTES, IdeEntrySchema, IdePathSchema } from "@ardurbot/contracts";
import { IsolationError, parseComputerMode } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";

type Deps = Pick<RouterDeps, "prisma" | "sandbox" | "home">;
type Request = { botId: string; computerId: string; generation: number; path: string };

export function workspaceFileSource(
  computer: {
    kind: string;
    state: string;
    providerRef: string | null;
    homeRevision: string;
    maintenanceId: string | null;
  } | null,
): WorkspaceContext["files"] {
  // Host folders require an explicit registered-root choice; a bot has no implicit host root.
  if (!computer || computer.kind === "fake" || computer.kind === "desktop") return "unavailable";
  if (computer.state === "running" && computer.providerRef && !computer.maintenanceId)
    return "live";
  if (computer.homeRevision !== "empty") return "saved";
  return "unavailable";
}

export function createWorkspaceFiles(deps: Deps) {
  async function target(actor: Actor, botId: string) {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      include: { computer: true },
    });
    if (!bot) throw new IsolationError();
    return bot;
  }
  function context(
    botId: string,
    computer: Awaited<ReturnType<typeof target>>["computer"],
  ): WorkspaceContext {
    return {
      botId,
      computerId: computer?.id ?? null,
      generation: computer?.screenGeneration ?? null,
      files: workspaceFileSource(computer),
      observedAt: new Date().toISOString(),
    };
  }
  async function resolve(actor: Actor, input: Request) {
    IdePathSchema.parse(input.path);
    const bot = await target(actor, input.botId);
    const computer = bot.computer;
    if (
      !computer ||
      computer.id !== input.computerId ||
      computer.screenGeneration !== input.generation
    )
      throw new ORPCError("CONFLICT", { message: "Computer changed. Refresh files." });
    const state = context(input.botId, computer);
    if (state.files === "unavailable")
      throw new ORPCError("CONFLICT", { message: "Files are unavailable on this computer." });
    const mode = parseComputerMode(computer.scope);
    const root = mode === "team" ? teamBotWorkspaceDirectory(bot.id) : "";
    const filePath = workspacePath(root, input.path);
    const operationId = `workspace-${randomUUID()}`;
    const adapterContext: AdapterContext = {
      userId: actor.userId,
      spaceId: actor.spaceId,
      botId: bot.id,
      operationId,
      traceId: operationId,
      signal: new AbortController().signal,
    };
    return { computer, state, root, filePath, adapterContext };
  }
  return {
    async describe(actor: Actor, botId: string) {
      const bot = await target(actor, botId);
      return context(botId, bot.computer);
    },
    async list(actor: Actor, input: Request) {
      const { computer, state, root, filePath, adapterContext } = await resolve(actor, input);
      const entries =
        state.files === "live"
          ? await deps.sandbox.listFiles(toComputerRef(computer), filePath, adapterContext)
          : await deps.home.list(computer.homeKey, filePath, adapterContext);
      const mapped = entries.flatMap((entry) => {
        const relative = path.posix.relative(root || ".", entry.path);
        const parsed = IdeEntrySchema.safeParse({ ...entry, path: relative });
        return parsed.success && !relative.startsWith("..") ? [parsed.data] : [];
      });
      return { context: state, entries: mapped };
    },
    async read(actor: Actor, input: Request) {
      const { computer, state, filePath, adapterContext } = await resolve(actor, input);
      if (!input.path) throw new ORPCError("BAD_REQUEST");
      const bytes =
        state.files === "live"
          ? await deps.sandbox.readFile(toComputerRef(computer), filePath, adapterContext, {
              maxBytes: IDE_FILE_BYTES + 1,
              preview: true,
            })
          : new TextEncoder().encode(
              await deps.home.readFile(computer.homeKey, filePath, adapterContext, {
                maxBytes: IDE_FILE_BYTES + 1,
                preview: true,
              }),
            );
      if (bytes.byteLength > IDE_FILE_BYTES || bytes.includes(0))
        throw new ORPCError("BAD_REQUEST", { message: "Preview unavailable for this file." });
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new ORPCError("BAD_REQUEST", { message: "Preview unavailable for this file." });
      }
      return { context: state, path: input.path, content };
    },
  };
}
