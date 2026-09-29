import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import { teamBotWorkspaceDirectory, toComputerRef, workspacePath } from "@ardurbot/adapters";
import type { Actor, WorkspaceContext } from "@ardurbot/contracts";
import { IDE_FILE_BYTES, IdeEntrySchema, IdePathSchema } from "@ardurbot/contracts";
import { resolveActionApproval } from "@ardurbot/core";
import { IsolationError, parseComputerMode } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";

type Deps = Pick<RouterDeps, "prisma" | "sandbox" | "home">;
type Request = { botId: string; computerId: string; generation: number; path: string };
type SaveRequest = Request & { content: string; version: string; approved: boolean };
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

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
  async function resolve(actor: Actor, input: Request, signal?: AbortSignal) {
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
      signal: signal ?? new AbortController().signal,
    };
    return { computer, state, root, filePath, adapterContext };
  }
  async function list(actor: Actor, input: Request, signal?: AbortSignal) {
    const { computer, state, root, filePath, adapterContext } = await resolve(actor, input, signal);
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
  }
  async function read(actor: Actor, input: Request, signal?: AbortSignal) {
    const { computer, state, filePath, adapterContext } = await resolve(actor, input, signal);
    if (!input.path) throw new ORPCError("BAD_REQUEST");
    const parent = path.posix.dirname(input.path);
    const listed = await list(actor, { ...input, path: parent === "." ? "" : parent }, signal);
    const entry = listed.entries.find((item) => item.path === input.path && item.kind === "file");
    if (!entry) throw new IsolationError();
    let bytes: Uint8Array;
    if (state.files === "live") {
      bytes = await deps.sandbox.readFile(toComputerRef(computer), filePath, adapterContext, {
        maxBytes: IDE_FILE_BYTES + 1,
        preview: true,
      });
    } else {
      bytes = new TextEncoder().encode(
        await deps.home
          .readFile(computer.homeKey, filePath, adapterContext, {
            maxBytes: IDE_FILE_BYTES + 1,
            preview: true,
          })
          .catch((error: unknown) => {
            if (error instanceof Error && error.message === "Binary file") return "\0";
            throw error;
          }),
      );
    }
    const readOnly =
      entry.size > IDE_FILE_BYTES ||
      bytes.byteLength > IDE_FILE_BYTES ||
      bytes.byteLength < entry.size;
    let content = "";
    let binary = bytes.includes(0);
    if (!binary) {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, IDE_FILE_BYTES),
          { stream: readOnly },
        );
      } catch {
        binary = true;
      }
    }
    return {
      context: state,
      path: input.path,
      size: Math.max(entry.size, bytes.length),
      executable: entry.executable,
      content: binary ? "" : content,
      binary,
      readOnly: readOnly || binary,
      version: digest(bytes),
    };
  }
  async function save(actor: Actor, input: SaveRequest, signal?: AbortSignal) {
    const bytes = new TextEncoder().encode(input.content);
    if (bytes.length > IDE_FILE_BYTES)
      return {
        saved: false,
        approvalRequired: false,
        reason: "Read only: file is larger than 2 MB",
      };
    const target = await resolve(actor, input, signal);
    if (target.computer.maintenanceId)
      throw new ORPCError("CONFLICT", { message: "Computer is busy" });
    const rules = await deps.prisma.actionApprovalRule.findMany({
      where: { spaceId: actor.spaceId, createdByUserId: actor.userId },
    });
    const bots =
      target.computer.scope === "team"
        ? await deps.prisma.bot.findMany({
            where: { computerId: target.computer.id, spaceId: actor.spaceId },
            select: { id: true },
          })
        : [];
    const botIds = bots.length ? bots.map((bot) => bot.id) : [input.botId];
    const approvalRequired = botIds.some(
      (botId) =>
        resolveActionApproval({
          toolName: "write_file",
          botId,
          rules: rules.map((rule) => ({
            ...rule,
            effect: rule.effect as "always_allow" | "require_approval",
            matchKind: rule.matchKind as "tool" | "connector" | "category",
          })),
        }) === "ask",
    );
    if (approvalRequired && !input.approved) return { saved: false, approvalRequired: true };
    const current = await read(actor, input, signal);
    if (current.binary) return { saved: false, approvalRequired: false, reason: "Binary file" };
    if (current.readOnly)
      return {
        saved: false,
        approvalRequired: false,
        reason: current.size > IDE_FILE_BYTES ? "Read only: file is larger than 2 MB" : "Read only",
      };
    if (current.version !== input.version)
      return {
        saved: false,
        approvalRequired: false,
        reason: "The file changed. Open it again before saving.",
      };
    if (target.state.files === "live") {
      await deps.sandbox.writeFile(
        toComputerRef(target.computer),
        { path: target.filePath, content: bytes, executable: current.executable },
        target.adapterContext,
      );
      await deps.prisma.computer.updateMany({
        where: { id: target.computer.id },
        data: { updatedAt: new Date() },
      });
    } else {
      await deps.home.writeFile(
        target.computer.homeKey,
        target.filePath,
        input.content,
        target.adapterContext,
      );
    }
    return { saved: true, approvalRequired: false, version: digest(bytes) };
  }
  return {
    async describe(actor: Actor, botId: string) {
      const bot = await target(actor, botId);
      return context(botId, bot.computer);
    },
    list,
    read,
    save,
  };
}
