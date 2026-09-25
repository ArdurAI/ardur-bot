import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AdapterContext, ComputerFileEntry } from "@ardurbot/adapter-kit";
import { DesktopSandboxProvider, toComputerRef } from "@ardurbot/adapters";
import type { Actor, IdeFile, IdeRoot } from "@ardurbot/contracts";
import { IDE_FILE_BYTES, IdeEntrySchema, IdePathSchema } from "@ardurbot/contracts";
import type { HostOperation } from "@ardurbot/contracts/host-bridge";
import { resolveActionApproval } from "@ardurbot/core";
import { IsolationError, requireMembership } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import { sourceHostStatus } from "./host-status.js";
import type { RouterDeps } from "./router.js";

type Deps = Pick<RouterDeps, "prisma" | "sandbox" | "home" | "hostBridge"> & {
  env?: Pick<RouterDeps["env"], "sandboxProvider">;
};
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const ideHostPaths = (root: string) =>
  /^[a-z]:[\\/]/i.test(root) || root.startsWith("\\\\") ? path.win32 : path.posix;

export function createIdeFiles(deps: Deps) {
  const sourceFiles = new DesktopSandboxProvider({ restricted: true });
  const sourceHost = (actor: Actor) =>
    actor.isDeploymentOwner && deps.env
      ? sourceHostStatus(deps.prisma, actor.userId, deps.env.sandboxProvider)
      : null;
  async function hostFile(actor: Actor, operation: HostOperation, signal?: AbortSignal) {
    try {
      const source = await sourceHost(actor);
      if (
        source &&
        "path" in operation &&
        typeof operation.path === "string" &&
        operation.op.startsWith("computer.files.")
      ) {
        const filePath = operation.path;
        const root = source.roots.find((root) => {
          const relative = path.relative(root, filePath);
          return (
            relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
          );
        });
        if (!root) throw new IsolationError();
        const computer = {
          id: `ide-${digest(root)}`,
          kind: "desktop" as const,
          botId: "ide",
          providerRef: root,
        };
        const context = {
          userId: actor.userId,
          spaceId: actor.spaceId,
          operationId: `ide-${randomUUID()}`,
          traceId: "ide",
          signal: signal ?? new AbortController().signal,
        };
        const relative = path.relative(root, filePath);
        if (operation.op === "computer.files.list") {
          const entries = await sourceFiles.listFiles(computer, relative, context);
          return {
            bytes: new Uint8Array(),
            result: entries.map((entry) => ({ ...entry, path: path.join(root, entry.path) })),
          };
        }
        if (operation.op === "computer.files.read")
          return {
            bytes: await sourceFiles.readFile(computer, relative, context, {
              maxBytes: IDE_FILE_BYTES + 1,
              preview: true,
            }),
            result: undefined,
          };
        if (operation.op === "computer.files.write") {
          await sourceFiles.writeFile(computer, {
            path: relative,
            content: Buffer.from(operation.content, "base64"),
            executable: operation.executable,
          });
          return { bytes: new Uint8Array(), result: undefined };
        }
      }
      return await deps.hostBridge!.ownerFile(actor, operation, signal);
    } catch (error) {
      throw new ORPCError("BAD_REQUEST", {
        message: error instanceof Error ? error.message : "Host file operation is unavailable.",
      });
    }
  }
  async function roots(actor: Actor): Promise<IdeRoot[]> {
    await requireMembership(deps.prisma, actor.userId, actor.spaceId);
    const [bots, host] = await Promise.all([
      deps.prisma.bot.findMany({
        where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
        include: { computer: true },
        orderBy: { id: "asc" },
      }),
      actor.isDeploymentOwner
        ? (async () => (await sourceHost(actor)) ?? deps.hostBridge?.status(actor.userId))()
        : undefined,
    ]);
    const result: IdeRoot[] = (host?.configured || host?.connected ? host.roots : []).map(
      (root) => ({
        id: `host-${digest(root)}`,
        kind: "host",
        name: ideHostPaths(root).basename(root) || root,
        path: root,
        computerId: null,
        botId: null,
      }),
    );
    const seen = new Set<string>();
    for (const bot of bots) {
      const computer = bot.computer;
      if (
        !computer ||
        computer.kind === "desktop" ||
        seen.has(computer.id) ||
        computer.spaceId !== actor.spaceId ||
        (computer.scope === "dedicated" && computer.userId !== actor.userId) ||
        (computer.scope === "team" && computer.scopeKey !== `team:${actor.spaceId}`)
      )
        continue;
      seen.add(computer.id);
      result.push({
        id: `sandbox-${computer.id}`,
        kind: "sandbox",
        name: bot.name,
        path: "/",
        computerId: computer.id,
        botId: bot.id,
      });
    }
    return result;
  }
  async function resolve(actor: Actor, rootId: string, relative = "", signal?: AbortSignal) {
    const safe = IdePathSchema.parse(relative);
    const root = (await roots(actor)).find((candidate) => candidate.id === rootId);
    if (!root) throw new IsolationError();
    const context: AdapterContext = {
      userId: actor.userId,
      spaceId: actor.spaceId,
      botId: root.botId ?? undefined,
      operationId: `ide-${randomUUID()}`,
      traceId: "ide",
      signal: signal ?? new AbortController().signal,
    };
    const computer = root.computerId
      ? await deps.prisma.computer.findFirst({
          where: {
            id: root.computerId,
            spaceId: actor.spaceId,
            OR: [
              { scope: "team", scopeKey: `team:${actor.spaceId}` },
              { scope: "dedicated", userId: actor.userId },
            ],
          },
        })
      : null;
    if (root.kind === "sandbox" && (!computer || computer.maintenanceId))
      throw new ORPCError("CONFLICT", { message: "Computer is busy" });
    return {
      root,
      computer,
      context,
      path: root.kind === "host" ? ideHostPaths(root.path).join(root.path, safe) : safe,
    };
  }
  async function list(actor: Actor, input: { rootId: string; path: string }, signal?: AbortSignal) {
    const target = await resolve(actor, input.rootId, input.path, signal);
    let entries: ComputerFileEntry[];
    if (target.root.kind === "host") {
      const { result } = await hostFile(
        actor,
        { op: "computer.files.list", homeKey: "ide", path: target.path },
        signal,
      );
      if (!Array.isArray(result)) throw new Error("Host file listing is unavailable.");
      entries = result.map((entry) => ({
        ...entry,
        path: ideHostPaths(target.root.path)
          .relative(target.root.path, entry.path)
          .split(ideHostPaths(target.root.path).sep)
          .join("/"),
      }));
    } else {
      const computer = target.computer!;
      entries =
        computer.state === "running" && computer.providerRef
          ? await deps.sandbox.listFiles(toComputerRef(computer), target.path, target.context)
          : await deps.home.list(computer.homeKey, target.path, target.context);
    }
    const parsed = entries.map((entry) => IdeEntrySchema.safeParse(entry));
    return {
      hiddenCount: parsed.filter((entry) => !entry.success).length,
      entries: parsed
        .flatMap((entry) => (entry.success ? [entry.data] : []))
        .filter((entry) => path.posix.dirname(entry.path) === (input.path || "."))
        .sort((a, b) =>
          a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "dir" ? -1 : 1,
        ),
    };
  }
  async function read(
    actor: Actor,
    input: { rootId: string; path: string },
    signal?: AbortSignal,
  ): Promise<IdeFile> {
    const target = await resolve(actor, input.rootId, input.path, signal);
    const entries = await list(
      actor,
      {
        rootId: input.rootId,
        path: path.posix.dirname(input.path) === "." ? "" : path.posix.dirname(input.path),
      },
      signal,
    );
    const entry = entries.entries.find(
      (entry) => entry.path === input.path && entry.kind === "file",
    );
    if (!entry) throw new IsolationError();
    let bytes: Uint8Array;
    if (target.root.kind === "host") {
      ({ bytes } = await hostFile(
        actor,
        {
          op: "computer.files.read",
          homeKey: "ide",
          path: target.path,
          maxBytes: IDE_FILE_BYTES + 1,
          editor: true,
        },
        signal,
      ));
    } else {
      const computer = target.computer!;
      bytes =
        computer.state === "running" && computer.providerRef
          ? await deps.sandbox.readFile(toComputerRef(computer), target.path, target.context, {
              maxBytes: IDE_FILE_BYTES + 1,
              preview: true,
            })
          : new TextEncoder().encode(
              await deps.home
                .readFile(computer.homeKey, target.path, target.context, {
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
      path: input.path,
      size: Math.max(entry.size, bytes.length),
      executable: entry.executable,
      content: binary ? "" : content,
      binary,
      readOnly: readOnly || binary,
      version: digest(bytes),
    };
  }
  async function save(
    actor: Actor,
    input: { rootId: string; path: string; content: string; version: string; approved: boolean },
    signal?: AbortSignal,
  ) {
    const bytes = new TextEncoder().encode(input.content);
    if (bytes.length > IDE_FILE_BYTES)
      return {
        saved: false,
        approvalRequired: false,
        reason: "Read only: file is larger than 2 MB",
      };
    const target = await resolve(actor, input.rootId, input.path, signal);
    const rules = await deps.prisma.actionApprovalRule.findMany({
      where: { spaceId: actor.spaceId, createdByUserId: actor.userId },
    });
    const bots =
      target.computer?.scope === "team"
        ? await deps.prisma.bot.findMany({
            where: { computerId: target.computer.id, spaceId: actor.spaceId },
            select: { id: true },
          })
        : [];
    const botIds = bots.length ? bots.map((bot) => bot.id) : [target.root.botId ?? undefined];
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
    if (target.root.kind === "host") {
      await hostFile(
        actor,
        {
          op: "computer.files.write",
          homeKey: "ide",
          path: target.path,
          content: Buffer.from(bytes).toString("base64"),
          editor: true,
          executable: current.executable,
        },
        signal,
      );
    } else {
      const computer = target.computer!;
      if (computer.state === "running" && computer.providerRef) {
        await deps.sandbox.writeFile(
          toComputerRef(computer),
          { path: target.path, content: bytes, executable: current.executable },
          target.context,
        );
        await deps.prisma.computer.updateMany({
          where: { id: computer.id },
          data: { updatedAt: new Date() },
        });
      } else
        await deps.home.writeFile(computer.homeKey, target.path, input.content, target.context);
    }
    return { saved: true, approvalRequired: false, version: digest(bytes) };
  }
  return { roots, resolve, list, read, save };
}
