import { createHash, randomUUID } from "node:crypto";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { EncryptedSecretStore } from "@ardurbot/adapters";
import { McpConnector } from "@ardurbot/adapters";
import type { Actor, LocalServerConfig, ManagedServerInputSchema } from "@ardurbot/contracts";
import { LocalServerConfigSchema, McpDiagnosticsSchema } from "@ardurbot/contracts";
import type { McpServer, Prisma, PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import { redactMcpArguments, redactMcpText } from "@ardurbot/host-runtime/mcp-diagnostics";
import { ORPCError } from "@orpc/server";
import type * as z from "zod";
import type { HostBridge } from "./host-bridge.js";
import { mcpServerDto } from "./mcp-server-dto.js";
import { createOwnerPreviews } from "./pending-previews.js";

type Owner = Pick<Actor, "spaceId" | "userId">;
type Material = {
  redactions?: string[];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  secret?: string;
};
type ManagedInput = z.infer<typeof ManagedServerInputSchema>;
const saved = "[saved]";
const scope = (owner: Owner) => ({ spaceId: owner.spaceId, userId: owner.userId });
function context(owner: Owner): AdapterContext {
  return {
    ...owner,
    operationId: "mcp-settings",
    traceId: "mcp-settings",
    signal: AbortSignal.timeout(30_000),
  };
}
function revision(rows: McpServer[]) {
  return createHash("sha256")
    .update(JSON.stringify(rows.map((row) => [row.id, row.revision]).sort()))
    .digest("hex");
}
function publicConfig(
  config: LocalServerConfig,
  redactions: Record<string, string[]> = {},
): LocalServerConfig {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(config.mcpServers).map(([slug, server]) => [
        slug,
        {
          ...server,
          command: redactMcpText(server.command, [
            ...(redactions[slug] ?? []),
            ...Object.values(server.env),
            ...(server.secret ? [server.secret] : []),
          ]),
          args: redactMcpArguments(server.args, [
            ...(redactions[slug] ?? []),
            ...Object.values(server.env),
            ...(server.secret ? [server.secret] : []),
          ]),
          env: Object.fromEntries(Object.keys(server.env).map((key) => [key, "[redacted]"])),
          ...(server.secret ? { secret: "[redacted]" } : {}),
        },
      ]),
    ),
  };
}
export function configDiff(
  before: LocalServerConfig,
  after: LocalServerConfig,
  redactions: Record<string, string[]> = {},
) {
  const a = publicConfig(before, redactions).mcpServers,
    b = publicConfig(after, redactions).mcpServers;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((name) => {
    const left = a[name] ? JSON.stringify(a[name], null, 2) : null;
    const right = b[name] ? JSON.stringify(b[name], null, 2) : null;
    // Changed secrets must produce a visible change, even though neither value is returned.
    if (JSON.stringify(before.mcpServers[name]) === JSON.stringify(after.mcpServers[name]))
      return [];
    return [
      {
        name,
        action: (!left ? "add" : !right ? "remove" : "change") as "add" | "change" | "remove",
        before: left,
        after: right,
      },
    ];
  });
}
export function parseServerConfig(json: string): LocalServerConfig {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Enter valid JSON." });
  }
  const result = LocalServerConfigSchema.safeParse(value);
  if (!result.success)
    throw new ORPCError("BAD_REQUEST", {
      message: "Check server names, commands, arguments, and environment fields.",
    });
  return result.data;
}

export function createMcpSettings(deps: {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  hostBridge?: HostBridge;
}) {
  const previews = createOwnerPreviews<{
    owner: Owner;
    revision: string;
    config: LocalServerConfig;
    redactions: Record<string, string[]>;
    expires: number;
  }>();
  async function requireHostOwner(owner: Owner) {
    const deployment = await deps.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
    });
    if (
      deployment?.ownerUserId !== owner.userId ||
      !deps.hostBridge ||
      !(await deps.hostBridge.status(owner.userId)).configured
    )
      throw new ORPCError("FORBIDDEN", { message: "Connect this computer as its owner first." });
  }
  async function stopHost(owner: Owner, rows: McpServer[]) {
    if (!deps.hostBridge || !(await deps.hostBridge.status(owner.userId)).connected) return;
    for (const row of rows.filter((row) => row.placement === "host"))
      await deps.hostBridge.result(
        { op: "mcp.stop", serverId: row.id, revision: row.revision },
        context(owner),
      );
  }
  async function material(
    row: McpServer,
    tx: Prisma.TransactionClient = deps.prisma,
  ): Promise<Material> {
    if (!row.secretId) return {};
    const secret = await tx.secret.findFirst({ where: { ...scope(row), id: row.secretId } });
    if (!secret) throw new Error("Reconnect this server to restore its configuration.");
    return JSON.parse(deps.secrets.load(secret.ciphertext, secret.id));
  }
  async function localRows(owner: Owner, tx: Prisma.TransactionClient = deps.prisma) {
    return tx.mcpServer.findMany({
      where: { ...scope(owner), transport: "stdio" },
      orderBy: { slug: "asc" },
    });
  }
  async function configuration(
    rows: McpServer[],
    reveal: boolean,
    tx?: Prisma.TransactionClient,
  ): Promise<LocalServerConfig> {
    const entries = await Promise.all(
      rows
        .filter((row) => !row.managedBy && !row.catalogId)
        .map(async (row) => {
          const stored = await material(row, tx);
          const args = stored.args ?? (Array.isArray(row.args) ? row.args.map(String) : []);
          const env = stored.env ?? {};
          const secrets = [
            ...(stored.redactions ?? []),
            ...Object.values(env),
            ...(stored.secret ? [stored.secret] : []),
          ];
          const redacted = redactMcpArguments(args, secrets);
          const command = stored.command ?? row.command ?? "";
          return [
            row.slug,
            {
              name: row.name,
              description: row.description,
              enabled: row.enabled,
              command: reveal || redactMcpText(command, secrets) === command ? command : saved,
              args: reveal ? args : args.map((arg, i) => (arg === redacted[i] ? arg : saved)),
              env: reveal ? env : Object.fromEntries(Object.keys(env).map((key) => [key, saved])),
              ...(stored.secret ? { secret: reveal ? stored.secret : saved } : {}),
            },
          ];
        }),
    );
    return { mcpServers: Object.fromEntries(entries) };
  }
  async function store(owner: Owner, value: Material, tx: Prisma.TransactionClient) {
    const secret = await deps.secrets.put(JSON.stringify(value), context(owner));
    await tx.secret.create({
      data: { ...scope(owner), id: secret.id, kind: "mcp", ciphertext: secret.ciphertext },
    });
    return secret.id;
  }
  async function removeRows(rows: McpServer[], tx: Prisma.TransactionClient) {
    for (const row of rows) {
      await tx.mcpServer.delete({ where: { id: row.id } });
      if (row.secretId) await tx.secret.deleteMany({ where: { ...scope(row), id: row.secretId } });
    }
  }
  return {
    async register(owner: Owner, input: ManagedInput) {
      if (input.placement === "host") await requireHostOwner(owner);
      const row = await deps.prisma.$transaction(async (tx) => {
        const lock = `${owner.spaceId}:${owner.userId}:${input.managedBy}:${input.managedId}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('managed-mcp'), hashtext(${lock}))`;
        const existing = await tx.mcpServer.findFirst({
          where: { ...scope(owner), managedBy: input.managedBy, managedId: input.managedId },
        });
        const value: Material = {
          command: input.command,
          args: input.args,
          env: input.env,
          cwd: input.cwd,
          redactions: input.secretValues,
        };
        if (
          existing &&
          JSON.stringify(await material(existing, tx)) === JSON.stringify(value) &&
          existing.name === input.name &&
          existing.description === input.description &&
          existing.placement === input.placement
        )
          return existing;
        const secretId = await store(owner, value, tx);
        const data = {
          ...scope(owner),
          name: input.name,
          description: input.description,
          transport: "stdio",
          command: redactMcpText(input.command, [
            ...Object.values(input.env),
            ...input.secretValues,
          ]),
          args: redactMcpArguments(input.args, [
            ...Object.values(input.env),
            ...input.secretValues,
          ]),
          env: Object.fromEntries(Object.keys(input.env).map((key) => [key, true])),
          secretId,
          managedBy: input.managedBy,
          managedId: input.managedId,
          placement: input.placement,
        };
        const updated = existing
          ? await tx.mcpServer.update({
              where: { id: existing.id },
              data: { ...data, revision: { increment: 1 } },
            })
          : await tx.mcpServer.create({
              data: {
                ...data,
                slug: `${input.managedBy}-${createHash("sha256").update(input.managedId).digest("hex").slice(0, 24)}`,
              },
            });
        if (existing?.secretId)
          await tx.secret.deleteMany({ where: { ...scope(owner), id: existing.secretId } });
        return updated;
      });
      await McpConnector.invalidateConnection(row.id, owner);
      return { serverId: row.id, revision: row.revision, ...scope(owner) };
    },
    async removeManaged(
      owner: Owner,
      input: { managedBy: "extension" | "plugin"; managedId: string },
    ) {
      const rows = await deps.prisma.mcpServer.findMany({ where: { ...scope(owner), ...input } });
      await stopHost(owner, rows);
      await deps.prisma.$transaction((tx) => removeRows(rows, tx));
      await Promise.all(rows.map((row) => McpConnector.invalidateConnection(row.id, owner)));
      return { ok: true as const };
    },
    async list(owner: Owner) {
      return (await localRows(owner)).map((row) => mcpServerDto(row));
    },
    async logs(owner: Owner, serverId: string) {
      const row = await deps.prisma.mcpServer.findFirst({
        where: { ...scope(owner), id: serverId, transport: "stdio" },
      });
      if (!row) throw new IsolationError();
      if (row.placement === "host") {
        const diagnostics = McpDiagnosticsSchema.safeParse(row.diagnostics).data;
        if (!row.enabled && diagnostics?.status === "error") return diagnostics;
        if (
          !row.enabled ||
          !deps.hostBridge ||
          !(await deps.hostBridge.status(owner.userId)).connected
        )
          return { status: "stopped" as const, lastError: null, lines: [], updatedAt: null };
        return McpDiagnosticsSchema.parse(
          await deps.hostBridge.result(
            { op: "mcp.status", serverId, revision: row.revision },
            context(owner),
          ),
        );
      }
      const diagnostics = McpDiagnosticsSchema.safeParse(row.diagnostics).data ?? {
        status: "stopped" as const,
        lastError: null,
        lines: [],
        updatedAt: null,
      };
      if (
        !row.enabled ||
        (diagnostics.status === "running" &&
          (!diagnostics.updatedAt || Date.now() - Date.parse(diagnostics.updatedAt) > 90_000))
      )
        diagnostics.status = "stopped";
      return diagnostics;
    },
    async config(owner: Owner) {
      const rows = await localRows(owner);
      return {
        json: JSON.stringify(await configuration(rows, false), null, 2),
        revision: revision(rows),
      };
    },
    async preview(owner: Owner, input: { json: string; revision: string }) {
      const rows = await localRows(owner);
      if (revision(rows) !== input.revision)
        throw new ORPCError("CONFLICT", {
          message: "The server configuration changed. Reload it and try again.",
        });
      const config = parseServerConfig(input.json);
      const before = await configuration(rows, true);
      const redactions = Object.fromEntries(
        await Promise.all(
          rows.map(async (row) => {
            const stored = await material(row);
            return [
              row.slug,
              [
                ...new Set([
                  ...(stored.redactions ?? []),
                  ...Object.values(stored.env ?? {}),
                  ...(stored.secret ? [stored.secret] : []),
                ]),
              ],
            ];
          }),
        ),
      );
      for (const [slug, server] of Object.entries(config.mcpServers)) {
        if (rows.some((row) => row.slug === slug && (row.managedBy || row.catalogId)))
          throw new ORPCError("BAD_REQUEST", { message: "Managed servers cannot be edited here." });
        const prior = before.mcpServers[slug];
        if (server.command === saved) {
          if (!prior)
            throw new ORPCError("BAD_REQUEST", { message: "Enter a command for the new server." });
          server.command = prior.command;
        }
        server.args = server.args.map((value, i) => {
          if (value !== saved) return value;
          if (prior?.args[i] === undefined)
            throw new ORPCError("BAD_REQUEST", { message: "Enter a value for the new argument." });
          return prior.args[i];
        });
        for (const key of Object.keys(server.env))
          if (server.env[key] === saved) {
            if (!(key in (prior?.env ?? {})))
              throw new ORPCError("BAD_REQUEST", {
                message: "Enter a value for the new environment field.",
              });
            server.env[key] = prior!.env[key]!;
          }
        if (server.secret === saved) {
          if (!prior?.secret)
            throw new ORPCError("BAD_REQUEST", {
              message: "Enter a value for the new credential.",
            });
          server.secret = prior.secret;
        }
      }
      const pending = previews(owner);
      if (pending.size >= 128) throw new ORPCError("TOO_MANY_REQUESTS");
      const id = randomUUID();
      pending.set(id, {
        owner,
        revision: input.revision,
        config,
        redactions,
        expires: Date.now() + 10 * 60_000,
      });
      return { id, changes: configDiff(before, config, redactions) };
    },
    async apply(owner: Owner, previewId: string, placement: "host" | "worker" = "worker") {
      if (placement === "host") await requireHostOwner(owner);
      const preview = previews(owner).get(previewId);
      if (
        !preview ||
        preview.expires <= Date.now() ||
        preview.owner.userId !== owner.userId ||
        preview.owner.spaceId !== owner.spaceId
      )
        throw new IsolationError();
      const changed = await deps.prisma.$transaction(
        async (tx) => {
          const lock = `${owner.spaceId}:${owner.userId}`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('developer-config'), hashtext(${lock}))`;
          const rows = await localRows(owner, tx);
          if (revision(rows) !== preview.revision)
            throw new ORPCError("CONFLICT", {
              message: "The server configuration changed. Reload it and try again.",
            });
          const editable = rows.filter((row) => !row.managedBy && !row.catalogId);
          await stopHost(owner, editable);
          await removeRows(
            editable.filter((row) => !preview.config.mcpServers[row.slug]),
            tx,
          );
          for (const [slug, server] of Object.entries(preview.config.mcpServers)) {
            const existing = editable.find((row) => row.slug === slug);
            const secretId = await store(
              owner,
              {
                command: server.command,
                args: server.args,
                env: server.env,
                secret: server.secret,
                redactions: preview.redactions[slug] ?? [],
              },
              tx,
            );
            const data = {
              ...scope(owner),
              slug,
              name: server.name,
              description: server.description,
              enabled: server.enabled,
              placement,
              transport: "stdio",
              command: redactMcpText(server.command, [
                ...(preview.redactions[slug] ?? []),
                ...Object.values(server.env),
                ...(server.secret ? [server.secret] : []),
              ]),
              args: redactMcpArguments(server.args, [
                ...(preview.redactions[slug] ?? []),
                ...Object.values(server.env),
                ...(server.secret ? [server.secret] : []),
              ]),
              env: Object.fromEntries(Object.keys(server.env).map((key) => [key, true])),
              secretId,
            };
            if (existing) {
              await tx.mcpServer.update({
                where: { id: existing.id },
                data: { ...data, revision: { increment: 1 } },
              });
              if (existing.secretId)
                await tx.secret.deleteMany({ where: { ...scope(owner), id: existing.secretId } });
            } else await tx.mcpServer.create({ data });
          }
          return editable;
        },
        { isolationLevel: "Serializable" },
      );
      previews(owner).delete(previewId);
      await Promise.all(changed.map((row) => McpConnector.invalidateConnection(row.id, owner)));
      return { ok: true as const };
    },
  };
}
