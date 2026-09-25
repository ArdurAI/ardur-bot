import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_AGENT_SKILLS, McpConnector, skillDocumentContext } from "@ardurbot/adapters";
import type { Actor, PluginInstall, PluginSummary } from "@ardurbot/contracts";
import { McpRemoteEndpointSchema, PluginSummarySchema } from "@ardurbot/contracts";
import type { BundleFile } from "@ardurbot/contracts/bundles/files";
import { bundleDocument, writeBundleFiles } from "@ardurbot/contracts/bundles/files";
import {
  parseMarketplace,
  parsePluginJson,
  planPlugin,
  pluginFiles,
  pluginInstallFiles,
} from "@ardurbot/contracts/bundles/plugins";
import { buildSkillMd, parseSkillMd } from "@ardurbot/core";
import type { PluginInstall as PluginRow, Prisma } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import { redactMcpArguments, redactMcpText } from "@ardurbot/host-runtime/mcp-diagnostics";
import { encodedBundle, uploadedBundle } from "./customization-files.js";
import { customizationCatalog } from "./customization-skills.js";
import { fetchMarketplaceGit } from "./marketplace-git.js";
import { createOwnerPreviews } from "./pending-previews.js";
import type { RouterDeps } from "./router.js";

type Plan = ReturnType<typeof planPlugin>;
type Preview = {
  owner: Actor;
  files: BundleFile[];
  plan: Plan;
  marketplaceId: string | null;
  source: PluginInstall["source"];
  categories: string[];
  expires: number;
};
const scope = (actor: Pick<Actor, "spaceId" | "userId">) => ({
  spaceId: actor.spaceId,
  userId: actor.userId,
});
const operationContext = (actor: Actor) => ({
  ...scope(actor),
  operationId: "plugins",
  traceId: "plugins",
  signal: AbortSignal.timeout(30_000),
});
export function pluginSummary(plan: Plan): PluginSummary {
  return {
    name: plan.name,
    description: plan.description,
    version: plan.version ?? null,
    author: plan.author?.name ?? null,
    skills: plan.skills.map((entry) => entry.path),
    commands: plan.commands.map((entry) => entry.path),
    servers: Object.keys(plan.servers),
    instructions: plan.instructions.map((entry) => entry.path),
  };
}
function installDto(row: PluginRow): PluginInstall {
  const summary = PluginSummarySchema.parse(row.summary);
  const meta = row.summary as Record<string, unknown>;
  return {
    ...summary,
    state: row.state as PluginInstall["state"],
    id: row.id,
    marketplaceId: row.marketplaceId,
    source: row.source as PluginInstall["source"],
    categories: Array.isArray(meta.categories) ? meta.categories.map(String) : [],
    createdAt: row.createdAt.toISOString(),
  };
}
function components(plan: Plan) {
  const instructions = plan.instructions.map((entry) => entry.content).join("\n\n");
  const rows = [
    ...plan.skills.map((entry) => {
      const skill = parseSkillMd(entry.content);
      if ("error" in skill) throw new Error(skill.error);
      return {
        name: `${plan.name}:${skill.name}`,
        description: skill.description,
        body: skill.body,
        componentKind: "skill",
      };
    }),
    ...plan.commands.map((entry) => ({
      name: `${plan.name}:${path.basename(entry.path, ".md")}`,
      description: plan.description || "Plugin command",
      body: entry.content,
      componentKind: "command",
    })),
    ...(instructions
      ? [
          {
            name: `${plan.name}:instructions`,
            description: plan.description || "Plugin instructions",
            body: instructions,
            componentKind: "instructions",
          },
        ]
      : []),
  ];
  const names = new Set<string>();
  return rows.map((entry) => {
    if (entry.name.length > 80 || names.has(entry.name.toLowerCase()))
      throw new Error("The plugin contains duplicate or overly long skill names.");
    names.add(entry.name.toLowerCase());
    return { ...entry, content: buildSkillMd(entry) };
  });
}
export function resolvePluginVariables(value: string, root: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    if (name === "CLAUDE_PLUGIN_ROOT") return root;
    throw new Error("This plugin requires configuration that is not provided.");
  });
}

export function createCustomizationPlugins(deps: RouterDeps) {
  const previews = createOwnerPreviews<Preview>();
  const folder = (actor: Actor, id: string) =>
    path.join(
      deps.dataDir,
      "plugins",
      createHash("sha256").update(`${actor.spaceId}:${actor.userId}`).digest("hex"),
      id,
    );
  async function payload(actor: Actor, secretId: string) {
    const secret = await deps.prisma.secret.findFirst({ where: { ...scope(actor), id: secretId } });
    if (!secret) throw new IsolationError();
    return uploadedBundle(JSON.parse(deps.secrets.load(secret.ciphertext, secret.id)));
  }
  async function marketplaces(actor: Actor) {
    const rows = await deps.prisma.customizationMarketplace.findMany({
      where: scope(actor),
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => {
      const manifest = parseMarketplace(row.manifest);
      return {
        id: row.id,
        name: row.name,
        source: row.source,
        plugins: manifest.plugins.map((entry) => ({
          name: entry.name,
          description: entry.description ?? "",
          author: entry.author?.name ?? null,
          categories: entry.category ? [entry.category] : (entry.tags ?? []),
        })),
      };
    });
  }
  async function uninstall(actor: Actor, id: string) {
    const row = await deps.prisma.pluginInstall.findFirst({ where: { ...scope(actor), id } });
    if (!row) throw new IsolationError();
    await deps.prisma.pluginInstall.update({ where: { id }, data: { state: "removing" } });
    const servers = await deps.prisma.mcpServer.findMany({
      where: { ...scope(actor), managedBy: "plugin", managedId: { startsWith: `${id}:` } },
    });
    if (deps.hostBridge && (await deps.hostBridge.status(actor.userId)).connected) {
      for (const server of servers.filter((row) => row.placement === "host"))
        await deps.hostBridge.result(
          { op: "mcp.stop", serverId: server.id, revision: server.revision },
          operationContext(actor),
        );
    }
    await deps.prisma.mcpServer.updateMany({
      where: { ...scope(actor), pluginId: id },
      data: { enabled: false },
    });
    const skills = await deps.prisma.agentSkill.findMany({
      where: { ...scope(actor), pluginId: id },
    });
    // Disable before touching the memory provider, so a retry never leaves a runnable partial plugin.
    await deps.prisma.agentSkill.updateMany({
      where: { ...scope(actor), pluginId: id },
      data: { enabled: false },
    });
    for (const skill of skills)
      if (skill.documentId && skill.activeRevision && deps.memoryDocuments) {
        const current = await deps.memoryDocuments.read(
          skill.documentId,
          skillDocumentContext(actor),
        );
        if (current && !current.deletedAt)
          await deps.memoryDocuments.delete(
            current.id,
            current.revision,
            skillDocumentContext(actor),
          );
      }
    await deps.prisma.$transaction(async (tx) => {
      await tx.agentSkill.deleteMany({ where: { ...scope(actor), pluginId: id } });
      await tx.mcpServer.deleteMany({
        where: { ...scope(actor), id: { in: servers.map((server) => server.id) } },
      });
      await tx.secret.deleteMany({
        where: {
          ...scope(actor),
          id: { in: servers.flatMap((server) => (server.secretId ? [server.secretId] : [])) },
        },
      });
      await tx.pluginInstall.delete({ where: { id } });
    });
    await Promise.all(servers.map((server) => McpConnector.invalidateConnection(server.id, actor)));
    await rm(folder(actor, id), { recursive: true, force: true });
    return { ok: true as const };
  }
  function previewFor(actor: Actor, id: string) {
    const preview = previews(actor).get(id);
    if (
      !preview ||
      preview.expires <= Date.now() ||
      preview.owner.spaceId !== actor.spaceId ||
      preview.owner.userId !== actor.userId
    )
      throw new IsolationError();
    return preview;
  }
  return {
    async list(actor: Actor) {
      const rows = await deps.prisma.pluginInstall.findMany({
        where: scope(actor),
        orderBy: { createdAt: "desc" },
      });
      return { installs: rows.map(installDto), marketplaces: await marketplaces(actor) };
    },
    async addMarketplace(actor: Actor, input: { url?: string; files?: BundleFile[] }) {
      const files = input.url ? await fetchMarketplaceGit(input.url) : input.files!;
      const document =
        bundleDocument(files, ".claude-plugin/marketplace.json") ??
        bundleDocument(files, "marketplace.json");
      if (!document) throw new Error("Choose a marketplace containing marketplace.json.");
      const manifest = parseMarketplace(parsePluginJson(document));
      const secret = await deps.secrets.put(
        JSON.stringify(encodedBundle(files)),
        operationContext(actor),
      );
      const safeManifest = {
        name: manifest.name,
        owner: manifest.owner,
        plugins: manifest.plugins.map((entry) => ({
          name: entry.name,
          source: entry.source,
          description: entry.description,
          author: entry.author,
          category: entry.category,
          tags: entry.tags,
        })),
      };
      await deps.prisma.$transaction(async (tx) => {
        await tx.secret.create({
          data: {
            ...scope(actor),
            id: secret.id,
            kind: "marketplace",
            ciphertext: secret.ciphertext,
          },
        });
        await tx.customizationMarketplace.create({
          data: {
            ...scope(actor),
            name: manifest.name,
            source: input.url ?? "local",
            secretId: secret.id,
            manifest: safeManifest as Prisma.InputJsonValue,
          },
        });
      });
      return (await marketplaces(actor)).find((row) => row.name === manifest.name)!;
    },
    async removeMarketplace(actor: Actor, id: string) {
      const row = await deps.prisma.customizationMarketplace.findFirst({
        where: { ...scope(actor), id },
      });
      if (!row) throw new IsolationError();
      const installs = await deps.prisma.pluginInstall.count({
        where: { ...scope(actor), marketplaceId: id },
      });
      if (installs) throw new Error("Uninstall this marketplace's plugins first.");
      await deps.prisma.$transaction(async (tx) => {
        await tx.customizationMarketplace.delete({ where: { id } });
        await tx.secret.deleteMany({ where: { ...scope(actor), id: row.secretId } });
      });
      return { ok: true as const };
    },
    async preview(
      actor: Actor,
      input: { name: string; marketplaceId?: string; catalogId?: string },
    ) {
      let files: BundleFile[],
        plan: Plan,
        categories: string[] = [];
      if (input.catalogId) {
        const entry = customizationCatalog.plugins.find((row) => row.id === input.catalogId);
        const skill = BUILTIN_AGENT_SKILLS[0];
        if (!entry || !skill) throw new IsolationError();
        categories = entry.categories;
        files = [
          {
            path: ".claude-plugin/plugin.json",
            bytes: Buffer.from(
              JSON.stringify({
                name: entry.id,
                description: entry.description,
                version: entry.version,
              }),
            ),
          },
          { path: "skills/interrogate/SKILL.md", bytes: Buffer.from(skill.content) },
          { path: "commands/review.md", bytes: Buffer.from(skill.content) },
        ];
        plan = planPlugin(files);
      } else {
        const marketplace = await deps.prisma.customizationMarketplace.findFirst({
          where: { ...scope(actor), id: input.marketplaceId },
        });
        if (!marketplace) throw new IsolationError();
        const source = await payload(actor, marketplace.secretId);
        const manifest = parseMarketplace(
          parsePluginJson(
            (bundleDocument(source, ".claude-plugin/marketplace.json") ??
              bundleDocument(source, "marketplace.json"))!,
          ),
        );
        const entry = manifest.plugins.find((row) => row.name === input.name);
        if (!entry) throw new IsolationError();
        categories = entry.category ? [entry.category] : (entry.tags ?? []);
        files =
          typeof entry.source === "string"
            ? pluginFiles(source, entry.source)
            : await fetchMarketplaceGit(
                entry.source.source === "github"
                  ? `https://github.com/${entry.source.repo}`
                  : entry.source.url,
                entry.source.ref,
                entry.source.sha,
              );
        plan = planPlugin(files, entry);
      }
      components(plan);
      const pending = previews(actor);
      if (pending.size >= 16) throw new Error("Finish a pending plugin install first.");
      const id = randomUUID();
      pending.set(id, {
        owner: actor,
        files,
        plan,
        marketplaceId: input.marketplaceId ?? null,
        source: input.catalogId ? "catalog" : "marketplace",
        categories,
        expires: Date.now() + 15 * 60_000,
      });
      return { id, summary: pluginSummary(plan) };
    },
    files(actor: Actor, id: string) {
      const preview = previewFor(actor, id);
      return encodedBundle(pluginInstallFiles(preview.files, preview.plan));
    },
    async install(
      actor: Actor,
      previewId: string,
      nativeRoot?: string,
      placement: "host" | "worker" = "worker",
      installationId?: string,
    ) {
      const preview = previewFor(actor, previewId);
      if (
        placement === "host" &&
        Object.values(preview.plan.servers).some((server) => server.command) &&
        (!actor.isDeploymentOwner ||
          !deps.hostBridge ||
          !(await deps.hostBridge.status(actor.userId)).configured)
      )
        throw new Error("Connect this computer as its owner first.");
      if (!deps.memoryDocuments && components(preview.plan).length)
        throw new Error("Connect memory storage before installing this plugin.");
      if (nativeRoot && !path.isAbsolute(nativeRoot))
        throw new Error("The plugin folder is invalid.");
      const id = installationId ?? randomUUID();
      const directory = nativeRoot ?? folder(actor, id);
      const row = await deps.prisma.pluginInstall.create({
        data: {
          id,
          ...scope(actor),
          name: preview.plan.name,
          source: preview.source,
          marketplaceId: preview.marketplaceId,
          digest: preview.plan.digest,
          summary: { ...pluginSummary(preview.plan), categories: preview.categories },
        },
      });
      const writtenDocuments: string[] = [];
      try {
        if (!nativeRoot) {
          await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
          await writeBundleFiles(directory, pluginInstallFiles(preview.files, preview.plan));
        }
        for (const component of components(preview.plan)) {
          const skillId = randomUUID();
          const document = await deps.memoryDocuments!.commit(
            {
              scope: "user",
              path: `skills/plugin-${id}-${skillId}.md`,
              content: component.content,
              expectedRevision: 0,
            },
            skillDocumentContext(actor),
          );
          writtenDocuments.push(document.id);
          await deps.prisma.agentSkill.create({
            data: {
              id: skillId,
              ...scope(actor),
              name: component.name,
              description: component.description,
              source: "plugin",
              origin: "user",
              pluginId: id,
              componentKind: component.componentKind,
              documentId: document.id,
              activeRevision: document.revision,
              enabled: false,
            },
          });
        }
        for (const [name, server] of Object.entries(preview.plan.servers)) {
          const resolve = (value: string) => resolvePluginVariables(value, directory);
          const env = Object.fromEntries(
            Object.entries(server.env ?? {}).map(([key, value]) => [key, resolve(value)]),
          );
          const args = (server.args ?? []).map(resolve);
          const command = server.command ? resolve(server.command) : null;
          const endpoint = server.url ? McpRemoteEndpointSchema.parse(resolve(server.url)) : null;
          const headers = Object.fromEntries(
            Object.entries(server.headers ?? {}).map(([key, value]) => [key, resolve(value)]),
          );
          const secret = await deps.secrets.put(
            JSON.stringify({ command, args, env, headers, cwd: directory }),
            operationContext(actor),
          );
          await deps.prisma.$transaction(async (tx) => {
            await tx.secret.create({
              data: { ...scope(actor), id: secret.id, kind: "mcp", ciphertext: secret.ciphertext },
            });
            await tx.mcpServer.create({
              data: {
                ...scope(actor),
                slug: `plugin-${createHash("sha256").update(`${id}:${name}`).digest("hex").slice(0, 24)}`,
                name: `${preview.plan.name}: ${name}`,
                description: preview.plan.description,
                transport: endpoint ? (server.type === "sse" ? "sse" : "streamable_http") : "stdio",
                endpoint,
                command: command
                  ? redactMcpText(command, [...Object.values(env), ...Object.values(headers)])
                  : null,
                args: redactMcpArguments(args, Object.values(env)),
                env: Object.fromEntries(Object.keys(env).map((key) => [key, true])),
                headers: Object.fromEntries(Object.keys(headers).map((key) => [key, true])),
                secretId: secret.id,
                pluginId: id,
                managedBy: "plugin",
                managedId: `${id}:${name}`,
                placement: nativeRoot && command ? placement : "worker",
                enabled: false,
              },
            });
          });
        }
        await deps.prisma.$transaction(async (tx) => {
          await tx.agentSkill.updateMany({
            where: { ...scope(actor), pluginId: id },
            data: { enabled: true },
          });
          await tx.mcpServer.updateMany({
            where: { ...scope(actor), managedBy: "plugin", managedId: { startsWith: `${id}:` } },
            data: { enabled: true },
          });
          await tx.pluginInstall.update({ where: { id }, data: { state: "installed" } });
        });
        previews(actor).delete(previewId);
        return installDto({ ...row, state: "installed" });
      } catch (error) {
        for (const documentId of writtenDocuments) {
          const document = await deps.memoryDocuments?.read(
            documentId,
            skillDocumentContext(actor),
          );
          if (document && !document.deletedAt)
            await deps.memoryDocuments!.delete(
              document.id,
              document.revision,
              skillDocumentContext(actor),
            );
        }
        if (await deps.prisma.pluginInstall.findFirst({ where: { ...scope(actor), id } }))
          await uninstall(actor, id);
        throw error;
      }
    },
    uninstall,
  };
}
