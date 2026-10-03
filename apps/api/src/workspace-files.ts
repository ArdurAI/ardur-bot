import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import {
  HomeContainmentError,
  LocalAgentHomeStore,
  teamBotWorkspaceDirectory,
  toComputerRef,
  workspacePath,
} from "@ardurbot/adapters";
import type { Actor, RuntimeComputerLocation, WorkspaceContext } from "@ardurbot/contracts";
import {
  computerRunsOnHost,
  IDE_FILE_BYTES,
  IdeEntrySchema,
  IdePathSchema,
} from "@ardurbot/contracts";
import { resolveActionApproval } from "@ardurbot/core";
import { IsolationError, parseComputerMode } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";

type Deps = Pick<RouterDeps, "prisma" | "sandbox" | "home">;
type Request = {
  botId: string;
  computerId: string;
  generation: number;
  path: string;
  rootId?: string;
};
type SaveRequest = Request & { content: string; version: string; approved: boolean };
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fileTooLargeReason = "This file is larger than 2 MB. Open a copy to edit it.";
const readOnlyReason = "This file is read-only. Open a copy to edit it.";
const binaryFileReason = "This is a binary file. You cannot edit it here.";
const fileMissingReason = "This file no longer exists. Save it as a new file or close it.";
const computerBusyMessage = "The computer is busy. Wait for it to finish.";

export function workspaceFileSource(
  computer:
    | (RuntimeComputerLocation & {
        kind: string;
        state: string;
        providerRef: string | null;
        homeRevision: string;
        maintenanceId: string | null;
      })
    | null,
): WorkspaceContext["files"] {
  if (!computer || computer.kind === "fake") return "unavailable";
  const host = computerRunsOnHost(computer);
  // The paired bridge requires run or maintenance authorization, not a pane request.
  if (host && computer.providerRef?.startsWith("host:")) return "unavailable";
  if (
    (computer.state === "running" || (host && computer.state === "suspended")) &&
    computer.providerRef &&
    !computer.maintenanceId
  )
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
      runsOnHost: computerRunsOnHost(computer ?? {}),
      ...(computer ? { rootId: `sandbox-${computer.id}` } : {}),
      observedAt: new Date().toISOString(),
    };
  }
  async function resolve(actor: Actor, input: Request, signal?: AbortSignal) {
    IdePathSchema.parse(input.path);
    const bot = await target(actor, input.botId);
    const computer = bot.computer;
    if (input.rootId !== undefined && input.rootId !== `sandbox-${computer?.id}`)
      throw new IsolationError();
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
      ...(state.runsOnHost ? { fileRoot: root } : {}),
      operationId,
      traceId: operationId,
      signal: signal ?? new AbortController().signal,
    };
    return { computer, state, root, filePath, adapterContext };
  }
  async function list(actor: Actor, input: Request, signal?: AbortSignal) {
    const { computer, state, root, filePath, adapterContext } = await resolve(actor, input, signal);
    if (state.files !== "live")
      await assertSavedInsideBotFolder(deps.home, computer.homeKey, root, filePath);
    const entries =
      state.files === "live"
        ? await deps.sandbox.listFiles(toComputerRef(computer), filePath, adapterContext)
        : await deps.home.list(computer.homeKey, filePath, adapterContext);
    const visible = [];
    for (const entry of entries) {
      if (state.files === "live") {
        visible.push(entry);
        continue;
      }
      try {
        await assertSavedInsideBotFolder(deps.home, computer.homeKey, root, entry.path);
      } catch (error) {
        if (error instanceof IsolationError) continue;
        throw error;
      }
      visible.push(entry);
    }
    const mapped = visible.flatMap((entry) => {
      const relative = path.posix.relative(root || ".", entry.path);
      const parsed = IdeEntrySchema.safeParse({ ...entry, path: relative });
      return parsed.success && !relative.startsWith("..") ? [parsed.data] : [];
    });
    return { context: state, entries: mapped };
  }
  async function read(actor: Actor, input: Request, signal?: AbortSignal) {
    const { computer, state, root, filePath, adapterContext } = await resolve(actor, input, signal);
    if (!input.path) throw new ORPCError("BAD_REQUEST");
    const parent = path.posix.dirname(input.path);
    const listed = await list(actor, { ...input, path: parent === "." ? "" : parent }, signal);
    const entry = listed.entries.find((item) => item.path === input.path && item.kind === "file");
    if (!entry) throw new IsolationError();
    let bytes: Uint8Array;
    if (state.files === "live") {
      bytes = await deps.sandbox
        .readFile(toComputerRef(computer), filePath, adapterContext, {
          maxBytes: IDE_FILE_BYTES + 1,
          preview: true,
        })
        .catch((error: unknown) => {
          // The file vanished after its folder listing; report it as missing.
          if (isMissing(error)) throw new IsolationError();
          throw error;
        });
    } else {
      await assertSavedInsideBotFolder(deps.home, computer.homeKey, root, filePath);
      bytes = new TextEncoder().encode(
        await deps.home
          .readFile(computer.homeKey, filePath, adapterContext, {
            maxBytes: IDE_FILE_BYTES + 1,
            preview: true,
          })
          .catch((error: unknown) => {
            // The file or one of its folders vanished after the listing.
            if (isMissing(error)) throw new IsolationError();
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
        reason: fileTooLargeReason,
      };
    const target = await resolve(actor, input, signal);
    if (target.computer.maintenanceId)
      throw new ORPCError("CONFLICT", { message: computerBusyMessage });
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
    let current: Awaited<ReturnType<typeof read>>;
    try {
      current = await read(actor, input, signal);
    } catch (error) {
      // The file was deleted or stopped being readable while its tab was open.
      if (error instanceof IsolationError)
        return { saved: false, approvalRequired: false, reason: fileMissingReason };
      throw error;
    }
    if (current.binary) return { saved: false, approvalRequired: false, reason: binaryFileReason };
    if (current.readOnly)
      return {
        saved: false,
        approvalRequired: false,
        reason: current.size > IDE_FILE_BYTES ? fileTooLargeReason : readOnlyReason,
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
    } else if (deps.home instanceof LocalAgentHomeStore) {
      // The boundary check and the write hold the home store's per-bot lock
      // together, so a concurrent commit cannot swap a directory or symlink
      // into place between them.
      try {
        await deps.home.writeFileInsideRoot(
          target.computer.homeKey,
          target.root,
          target.filePath,
          input.content,
          target.adapterContext,
        );
      } catch (error) {
        if (error instanceof HomeContainmentError) throw new IsolationError();
        throw error;
      }
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

/**
 * The home store allows a symlink whose target stays inside the computer home.
 * A team bot folder is narrower: the same link can land in another bot's files.
 */
async function assertSavedInsideBotFolder(
  home: Deps["home"],
  homeKey: string,
  workspaceRoot: string,
  filePath: string,
) {
  if (!workspaceRoot || !(home instanceof LocalAgentHomeStore)) return;
  let homeDir: string;
  try {
    homeDir = await realpath(home.pathFor(homeKey));
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const boundary = path.resolve(homeDir, ...workspaceRoot.split("/").filter(Boolean));
  await assertRealBoundary(homeDir, boundary);
  const relative = path.posix.relative(
    workspaceRoot.replaceAll("\\", "/"),
    filePath.replaceAll("\\", "/"),
  );
  if (!relative || relative === ".") return;
  if (relative.startsWith("..") || path.posix.isAbsolute(relative)) throw new IsolationError();
  await assertNoEscape(boundary, relative.split("/").filter(Boolean));
}

async function assertRealBoundary(homeDir: string, boundary: string) {
  const relative = path.relative(homeDir, boundary);
  if (!inside(homeDir, boundary)) throw new IsolationError();
  let current = homeDir;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(current, part);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(next);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new IsolationError();
    current = next;
  }
}

async function assertNoEscape(boundary: string, parts: string[]) {
  let current = boundary;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part === "." || part === "..") throw new IsolationError();
    const next = path.join(current, part);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(next);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const last = index === parts.length - 1;
    if (info.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = await realpath(next);
      } catch (error) {
        if (isMissing(error)) throw new IsolationError();
        throw error;
      }
      const canonical = await realpath(boundary);
      if (!inside(canonical, resolved)) throw new IsolationError();
      if (last) return;
      if (!(await stat(resolved)).isDirectory()) throw new IsolationError();
      current = resolved;
      continue;
    }
    if (!last && !info.isDirectory()) throw new IsolationError();
    current = next;
  }
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
