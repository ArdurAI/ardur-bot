import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { EncryptedSecretStore } from "@ardurbot/adapters";
import { DockerSandboxProvider, kubernetesContexts, snapshotKubeconfig } from "@ardurbot/adapters";
import type {
  Actor,
  NewBotComputerOptions,
  RuntimeComputerLocation,
  RuntimeKind,
} from "@ardurbot/contracts";
import {
  ComputerConfigurationSchema,
  ComputerConnectionInputSchema,
  ComputerConnectionSettingsSchema,
  ComputerEngineUnavailableError,
  computerExecutionKind,
  computerKindFacts,
  defaultNewBotLocation,
  FLEET_ACTIVE_RUN_CONFLICT_CODE,
  failureCategoryMessage,
  HOST_MOVE_UNAVAILABLE_CODE,
  HOST_MOVE_UNAVAILABLE_MESSAGE,
  newBotSandboxAvailable,
  recommendedContainer,
  runtimeNames,
  runtimeSupportsLocation,
} from "@ardurbot/contracts";
import { ACTIVE_RUN_STATUSES, sandboxKindForBot } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import type { z } from "zod";
import { cleanupFleetSecret, importFleetSecret } from "./fleet.js";
import type { HostBridge } from "./host-bridge.js";

/** Pairing is owner-scoped; no process probes or engine access are needed for this policy. */
export async function newBotHostAvailable(
  deps: { prisma: PrismaClient; hostBridge?: HostBridge },
  actor: Actor,
  sandboxProvider: string,
) {
  if (!actor.isDeploymentOwner) return false;
  const [settings, host] = await Promise.all([
    deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
    deps.hostBridge?.status(actor.userId),
  ]);
  if (settings?.ownerUserId !== actor.userId) return false;
  // Explicit local-host deployments use direct adapters, never a paired API bridge.
  const localHost =
    process.env.ARDURBOT_HOST_BRIDGE !== "api" &&
    sandboxKindForBot(sandboxProvider, settings?.computerHost) === "desktop";
  return localHost || Boolean(host?.configured && host.connected);
}

export async function newBotComputerOptions(
  deps: { prisma: PrismaClient; hostBridge?: HostBridge },
  actor: Actor,
  sandboxProvider: string,
): Promise<NewBotComputerOptions> {
  const [settings, hostAvailable, connections, teamComputer] = await Promise.all([
    deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
    newBotHostAvailable(deps, actor, sandboxProvider),
    listComputerConnections(deps.prisma, actor.spaceId),
    deps.prisma.computer.findFirst({
      where: { spaceId: actor.spaceId, scope: "team" },
      orderBy: [{ bots: { _count: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const teamKind = teamComputer
    ? computerExecutionKind({
        ...teamComputer,
        connectionSettings: connections.find((entry) => entry.id === teamComputer.connectionId)
          ?.settings,
      })
    : null;
  const container = recommendedContainer(sandboxProvider, connections);
  const sandboxAvailable = newBotSandboxAvailable(sandboxProvider, container);
  return {
    hostAvailable,
    sandboxAvailable,
    defaultLocation: defaultNewBotLocation({
      isDeploymentOwner: actor.isDeploymentOwner,
      hostConnected: hostAvailable,
      hostPaired: hostAvailable,
      computerHost: settings?.computerHost as "docker" | "this-mac" | null | undefined,
      sandboxAvailable,
    }),
    container,
    team:
      teamComputer && teamKind
        ? {
            location: teamKind === "desktop" ? ("host" as const) : ("sandbox" as const),
            connectionId: teamComputer.connectionId,
            name: connections.find((entry) => entry.id === teamComputer.connectionId)?.name,
          }
        : null,
  };
}

export async function listComputerConnections(prisma: PrismaClient, spaceId: string) {
  const rows = await prisma.connection.findMany({ where: { spaceId, connectorId: "computer" } });
  return rows.map((row) => ({
    id: row.id,
    name: row.displayName,
    status: row.status,
    settings: ComputerConnectionSettingsSchema.parse(row.metadata),
  }));
}
export async function saveComputerConnection(
  deps: { prisma: PrismaClient; secrets: EncryptedSecretStore; hostBridge?: HostBridge },
  raw: z.infer<typeof ComputerConnectionInputSchema>,
  context: AdapterContext,
) {
  const input = ComputerConnectionInputSchema.parse(raw);
  delete input.settings.hostSecretId;
  const importedIds: string[] = [];
  if (input.settings.dockerContext && !input.settings.endpoint)
    throw new Error("Choose the saved context endpoint.");
  let source = { inline: input.kubeconfig, path: input.kubeconfigPath };
  if (input.settings.engine === "kubernetes") {
    if (
      !source.inline &&
      process.env.ARDURBOT_HOST_BRIDGE === "api" &&
      deps.hostBridge &&
      input.settings.context
    ) {
      source = {
        inline: (await deps.hostBridge.fleetResult(
          {
            op: "computer.remote.kubeconfig",
            context: input.settings.context,
            ...(source.path ? { path: source.path } : {}),
          },
          context,
        )) as string,
        path: undefined,
      };
    } else if (!source.inline && !source.path)
      source.path = path.join(homedir(), ".kube", "config");
    if (Boolean(source.inline) === Boolean(source.path))
      throw new Error("Choose either a kubeconfig path or its contents.");
    const snapshot = await snapshotKubeconfig(source);
    source = { inline: snapshot.inline, path: snapshot.path };
    if (process.env.ARDURBOT_HOST_BRIDGE === "api" && source.inline) {
      const stored = await importFleetSecret(deps, { kubeconfig: source.inline }, context);
      importedIds.push(stored.id);
      input.settings.hostSecretId = stored.id;
    }
    const contexts = await kubernetesContexts(source);
    if (!contexts.some((entry) => entry.name === input.settings.context))
      throw new Error("Choose a Kubernetes context.");
  } else if (
    input.kubeconfig ||
    input.kubeconfigPath ||
    (input.settings.socket && !/^(?:unix:\/\/)?\//.test(input.settings.socket))
  )
    throw new Error("Choose a local engine socket.");
  if (input.settings.engine === "ssh" && !input.settings.ssh)
    throw new Error("Choose an SSH host and user.");
  if (input.privateKeyPath || input.tlsPaths) {
    const imported = await importFleetSecret(
      deps,
      { privateKeyPath: input.privateKeyPath, tlsPaths: input.tlsPaths },
      context,
    );
    importedIds.push(imported.id);
    input.settings.hostSecretId = imported.id;
  }
  if (input.settings.ssh?.authentication === "private-key" && !input.settings.hostSecretId)
    throw new Error("Choose an SSH key on this computer.");
  if (input.settings.endpoint?.startsWith("tcp://") && !input.settings.hostSecretId)
    throw new Error("Choose client TLS certificates on this computer.");
  const secret =
    input.settings.engine === "kubernetes"
      ? await deps.secrets.put(JSON.stringify(source), context)
      : undefined;
  const row = await deps.prisma.$transaction(async (tx) => {
    if (secret)
      await tx.secret.create({
        data: {
          id: secret.id,
          ciphertext: secret.ciphertext,
          kind: "computer",
          spaceId: context.spaceId,
          userId: context.userId,
        },
      });
    const created = await tx.connection.create({
      data: {
        spaceId: context.spaceId,
        userId: context.userId,
        connectorId: "computer",
        provider: input.settings.engine,
        displayName: input.name,
        status: "connected",
        metadata: input.settings,
        secretId: secret?.id,
      },
    });
    if (importedIds.length)
      await tx.fleetSecretCleanup.deleteMany({ where: { hostSecretId: { in: importedIds } } });
    return created;
  });
  return { id: row.id, name: row.displayName, settings: input.settings };
}
export async function updateComputerConnection(
  deps: { prisma: PrismaClient; secrets: EncryptedSecretStore; hostBridge?: HostBridge },
  connectionId: string,
  raw: z.infer<typeof ComputerConnectionInputSchema>,
  revision: string,
  confirmActive: boolean,
  context: AdapterContext,
) {
  const input = ComputerConnectionInputSchema.parse(raw);
  delete input.settings.hostSecretId;
  const previous = await deps.prisma.connection.findFirstOrThrow({
    where: {
      id: connectionId,
      spaceId: context.spaceId,
      userId: context.userId,
      connectorId: "computer",
    },
  });
  if (previous.updatedAt.toISOString() !== revision)
    throw new ORPCError("CONFLICT", { message: "This computer changed. Reload and try again." });
  const oldSettings = ComputerConnectionSettingsSchema.parse(previous.metadata);
  const { hostSecretId: _oldSecret, ...oldConnection } = oldSettings;
  const { hostSecretId: _newSecret, ...newConnection } = input.settings;
  const hasNewMaterial = Boolean(
    input.kubeconfig || input.kubeconfigPath || input.privateKeyPath || input.tlsPaths,
  );
  const changed = JSON.stringify(oldConnection) !== JSON.stringify(newConnection) || hasNewMaterial;
  if (!changed) {
    const saved = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM connections WHERE id = ${connectionId} AND "spaceId" = ${context.spaceId} AND "userId" = ${context.userId} AND "connectorId" = 'computer' FOR UPDATE`;
      const current = await tx.connection.findFirstOrThrow({
        where: {
          id: connectionId,
          spaceId: context.spaceId,
          userId: context.userId,
          connectorId: "computer",
        },
      });
      if (current.updatedAt.toISOString() !== revision)
        throw new ORPCError("CONFLICT", {
          message: "This computer changed. Reload and try again.",
        });
      const updated = await tx.connection.update({
        where: { id: connectionId },
        data: { displayName: input.name },
      });
      await tx.fleetAudit.create({
        data: { spaceId: context.spaceId, userId: context.userId, connectionId, action: "renamed" },
      });
      return updated;
    });
    return { changed: false, revision: saved.updatedAt.toISOString() };
  }
  if (
    changed &&
    !confirmActive &&
    (await deps.prisma.run.findFirst({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        status: { in: [...ACTIVE_RUN_STATUSES] },
        bot: { computer: { connectionId } },
      },
      select: { id: true },
    }))
  )
    throw new ORPCError("CONFLICT", {
      message: "Runs are active on this computer. Confirm the connection change.",
      data: { code: FLEET_ACTIVE_RUN_CONFLICT_CODE },
    });

  if (input.settings.dockerContext && !input.settings.endpoint)
    throw new Error("Choose the saved context endpoint.");
  if (input.settings.engine === "ssh" && !input.settings.ssh)
    throw new Error("Choose an SSH host and user.");
  if (input.settings.engine !== "kubernetes" && (input.kubeconfig || input.kubeconfigPath))
    throw new Error("Kubeconfig is only used by Kubernetes.");

  const importedIds: string[] = [];
  const importNewSecret = async (material: Parameters<typeof importFleetSecret>[1]) => {
    const secretId = randomUUID();
    importedIds.push(secretId);
    return importFleetSecret(deps, material, context, secretId);
  };
  try {
    let newSecret: Awaited<ReturnType<EncryptedSecretStore["put"]>> | undefined;
    let source: { inline?: string; path?: string } = {};
    let sourceChanged = false;
    if (input.settings.engine === "kubernetes") {
      if (input.kubeconfig && input.kubeconfigPath)
        throw new Error("Choose either a kubeconfig path or its contents.");
      if (input.kubeconfig || input.kubeconfigPath) {
        source = { inline: input.kubeconfig, path: input.kubeconfigPath };
        sourceChanged = true;
      } else if (previous.secretId) {
        const stored = await deps.prisma.secret.findFirstOrThrow({
          where: { id: previous.secretId, spaceId: context.spaceId, userId: context.userId },
        });
        source = JSON.parse(deps.secrets.load(stored.ciphertext, stored.id)) as typeof source;
      } else {
        source = { path: path.join(homedir(), ".kube", "config") };
        sourceChanged = true;
      }
      if (
        process.env.ARDURBOT_HOST_BRIDGE === "api" &&
        deps.hostBridge &&
        !input.kubeconfig &&
        source.path
      ) {
        source = {
          inline: (await deps.hostBridge.fleetResult(
            {
              op: "computer.remote.kubeconfig",
              context: input.settings.context!,
              path: source.path,
            },
            context,
          )) as string,
        };
        sourceChanged = true;
      }
      source = await snapshotKubeconfig(source);
      const contexts = await kubernetesContexts(source);
      if (!contexts.some((entry) => entry.name === input.settings.context))
        throw new Error("Choose a Kubernetes context.");
      if (sourceChanged || !previous.secretId)
        newSecret = await deps.secrets.put(JSON.stringify(source), context);
      if (
        process.env.ARDURBOT_HOST_BRIDGE === "api" &&
        source.inline &&
        (newSecret || !oldSettings.hostSecretId)
      ) {
        const imported = await importNewSecret({ kubeconfig: source.inline });
        input.settings.hostSecretId = imported.id;
      } else if (oldSettings.engine === "kubernetes")
        input.settings.hostSecretId = oldSettings.hostSecretId;
    } else if (input.privateKeyPath || input.tlsPaths) {
      const imported = await importNewSecret({
        privateKeyPath: input.privateKeyPath,
        tlsPaths: input.tlsPaths,
      });
      input.settings.hostSecretId = imported.id;
    } else if (
      oldSettings.engine === input.settings.engine &&
      (input.settings.ssh?.authentication === "private-key" ||
        input.settings.endpoint?.startsWith("tcp://"))
    ) {
      input.settings.hostSecretId = oldSettings.hostSecretId;
    }
    if (input.settings.ssh?.authentication === "private-key" && !input.settings.hostSecretId)
      throw new Error("Choose an SSH key on this computer.");
    if (input.settings.endpoint?.startsWith("tcp://") && !input.settings.hostSecretId)
      throw new Error("Choose client TLS certificates on this computer.");
    if (
      input.settings.engine !== "kubernetes" &&
      input.settings.engine !== "ssh" &&
      input.settings.socket &&
      !/^(?:unix:\/\/)?\//.test(input.settings.socket)
    )
      throw new Error("Choose a local engine socket.");

    const saved = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM connections WHERE id = ${connectionId} AND "spaceId" = ${context.spaceId} AND "userId" = ${context.userId} AND "connectorId" = 'computer' FOR UPDATE`;
      const current = await tx.connection.findFirstOrThrow({
        where: {
          id: connectionId,
          spaceId: context.spaceId,
          userId: context.userId,
          connectorId: "computer",
        },
      });
      if (current.updatedAt.toISOString() !== revision)
        throw new ORPCError("CONFLICT", {
          message: "This computer changed. Reload and try again.",
        });
      if (newSecret)
        await tx.secret.create({
          data: {
            id: newSecret.id,
            ciphertext: newSecret.ciphertext,
            kind: "computer",
            spaceId: context.spaceId,
            userId: context.userId,
          },
        });
      const updated = await tx.connection.update({
        where: { id: connectionId },
        data: {
          displayName: input.name,
          provider: input.settings.engine,
          metadata: input.settings,
          ...(newSecret
            ? { secretId: newSecret.id }
            : input.settings.engine !== "kubernetes"
              ? { secretId: null }
              : {}),
        },
      });
      if (previous.secretId && (newSecret || input.settings.engine !== "kubernetes"))
        await tx.secret.deleteMany({
          where: { id: previous.secretId, spaceId: context.spaceId, userId: context.userId },
        });
      await tx.fleetAudit.create({
        data: {
          spaceId: context.spaceId,
          userId: context.userId,
          connectionId,
          action: changed ? "connection-updated" : "renamed",
        },
      });
      if (importedIds.length)
        await tx.fleetSecretCleanup.deleteMany({ where: { hostSecretId: { in: importedIds } } });
      if (oldSettings.hostSecretId && oldSettings.hostSecretId !== input.settings.hostSecretId)
        await tx.fleetSecretCleanup.create({
          data: {
            hostSecretId: oldSettings.hostSecretId,
            spaceId: context.spaceId,
            userId: context.userId,
          },
        });
      return updated;
    });
    if (oldSettings.hostSecretId && oldSettings.hostSecretId !== input.settings.hostSecretId) {
      await cleanupFleetSecret(deps.prisma, deps.hostBridge, context, oldSettings.hostSecretId);
    }
    return { changed, revision: saved.updatedAt.toISOString() };
  } catch (error) {
    for (const hostSecretId of importedIds) {
      try {
        const [current, intent] = await Promise.all([
          deps.prisma.connection.findFirstOrThrow({
            where: {
              id: connectionId,
              spaceId: context.spaceId,
              userId: context.userId,
              connectorId: "computer",
            },
          }),
          deps.prisma.fleetSecretCleanup.findUnique({ where: { hostSecretId } }),
        ]);
        if (
          ComputerConnectionSettingsSchema.parse(current.metadata).hostSecretId === hostSecretId ||
          !intent
        )
          continue;
        await deps.prisma.fleetSecretCleanup.updateMany({
          where: { hostSecretId, spaceId: context.spaceId, userId: context.userId },
          data: { nextAttemptAt: new Date() },
        });
      } catch {
        // A failed read leaves the durable intent for the reconciler; deletion is unsafe.
      }
    }
    throw error;
  }
}
export async function validateComputerConfiguration(
  prisma: PrismaClient,
  spaceId: string,
  raw: z.infer<typeof ComputerConfigurationSchema>,
  sandboxProvider = "docker",
) {
  const configuration = ComputerConfigurationSchema.parse(raw);
  if (!configuration.confirmed)
    throw new ORPCError("BAD_REQUEST", {
      message: "This replaces the computer's files. Continue?",
    });
  // Null chooses the deployment default, which is refused while new computers start on the host.
  if (configuration.connectionId === null && configuration.destination !== "sandbox") {
    const deployment =
      sandboxProvider === "docker"
        ? await prisma.deploymentSettings.findUnique({ where: { id: "default" } })
        : null;
    if (sandboxKindForBot(sandboxProvider, deployment?.computerHost) === "desktop")
      throw new ORPCError("BAD_REQUEST", {
        message: HOST_MOVE_UNAVAILABLE_MESSAGE,
        data: { code: HOST_MOVE_UNAVAILABLE_CODE },
      });
  }
  if (
    configuration.connectionId &&
    !(await prisma.connection.findFirst({
      where: { id: configuration.connectionId, spaceId, connectorId: "computer" },
    }))
  )
    throw new ORPCError("BAD_REQUEST", { message: "Choose an available computer connection." });
  return configuration;
}

/** The same placement policy guards Settings and run admission, before any destructive work. */
export async function validateRuntimeComputerConfiguration(
  prisma: PrismaClient,
  bot: {
    runtimeKind: string;
    computer: { kind: string; connectionId: string | null; spaceId: string } | null;
  },
  configuration: z.infer<typeof ComputerConfigurationSchema>,
  deploymentKind: string,
  hostConnected: boolean,
) {
  if (configuration.destination === "host" && !hostConnected)
    throw new ORPCError("BAD_REQUEST", {
      message: "Connect the host service to choose This computer.",
    });
  const connectionId =
    configuration.destination === "host"
      ? null
      : configuration.connectionId === undefined
        ? bot.computer?.connectionId
        : configuration.connectionId;
  const connection = connectionId
    ? await prisma.connection.findFirst({
        where: { id: connectionId, spaceId: bot.computer?.spaceId, connectorId: "computer" },
      })
    : null;
  const parsed = ComputerConnectionSettingsSchema.safeParse(connection?.metadata);
  const location: RuntimeComputerLocation = {
    kind:
      configuration.destination === "host"
        ? "desktop"
        : configuration.connectionId === null
          ? deploymentKind
          : bot.computer?.kind,
    connectionId,
    connectionSettings: parsed.success ? parsed.data : null,
  };
  if (
    configuration.destination === "sandbox" &&
    computerKindFacts(computerExecutionKind(location) ?? "")?.boundary !== "container"
  )
    throw new ORPCError("BAD_REQUEST", { message: "Set up a container for isolated work." });
  const runtime = bot.runtimeKind as RuntimeKind;
  if (!runtimeSupportsLocation(runtime, location))
    throw new ORPCError("BAD_REQUEST", {
      message: failureCategoryMessage("computer-unsupported", {
        runtime: runtimeNames[runtime],
        bot: "this bot",
      }),
      data: { code: "computer-unsupported" },
    });
}

export async function computerEngineInfo(
  deps: {
    prisma: PrismaClient;
    env: { sandboxSupervisorUrl?: string; sandboxSupervisorToken?: string };
  },
  connectionId: string | null,
  context: AdapterContext,
) {
  const row = connectionId
    ? await deps.prisma.connection.findFirst({
        where: { id: connectionId, spaceId: context.spaceId, connectorId: "computer" },
      })
    : null;
  if (connectionId && !row) throw new Error("Computer connection is unavailable.");
  const settings = row ? ComputerConnectionSettingsSchema.parse(row.metadata) : undefined;
  if (settings?.engine === "ssh") return { name: "ssh" as const, rootless: false };
  if (settings?.engine === "kubernetes") return { name: "kubernetes" as const, rootless: false };
  if (settings?.endpoint || settings?.dockerContext)
    return { name: settings.engine as "docker" | "podman", rootless: false };
  const provider = new DockerSandboxProvider(
    deps.env.sandboxSupervisorUrl ?? "http://127.0.0.1:7091",
    deps.env.sandboxSupervisorToken,
    settings
      ? { name: settings.engine as "docker" | "podman", socket: settings.socket }
      : undefined,
  );
  try {
    return await provider.engineInfo(context);
  } catch (error) {
    if (error instanceof ComputerEngineUnavailableError)
      throw new ORPCError("SERVICE_UNAVAILABLE", { message: error.message });
    throw error;
  }
}
