import { homedir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { EncryptedSecretStore } from "@ardurbot/adapters";
import {
  DockerSandboxProvider,
  kubernetesContexts,
  localFleetService,
  snapshotKubeconfig,
} from "@ardurbot/adapters";
import {
  ComputerConfigurationSchema,
  ComputerConnectionInputSchema,
  ComputerConnectionSettingsSchema,
  ComputerEngineUnavailableError,
  HOST_MOVE_UNAVAILABLE_CODE,
  HOST_MOVE_UNAVAILABLE_MESSAGE,
} from "@ardurbot/contracts";
import { sandboxKindForBot } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import type { z } from "zod";
import { importFleetSecret } from "./fleet.js";
import type { HostBridge } from "./host-bridge.js";

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
    return tx.connection.create({
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
  });
  return { id: row.id, name: row.displayName, settings: input.settings };
}
export async function updateComputerConnection(
  deps: { prisma: PrismaClient; secrets: EncryptedSecretStore; hostBridge?: HostBridge },
  connectionId: string,
  raw: z.infer<typeof ComputerConnectionInputSchema>,
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
  const oldSettings = ComputerConnectionSettingsSchema.parse(previous.metadata);
  const { hostSecretId: _oldSecret, ...oldConnection } = oldSettings;
  const { hostSecretId: _newSecret, ...newConnection } = input.settings;
  const hasNewMaterial = Boolean(
    input.kubeconfig || input.kubeconfigPath || input.privateKeyPath || input.tlsPaths,
  );
  const changed = JSON.stringify(oldConnection) !== JSON.stringify(newConnection) || hasNewMaterial;
  if (!changed) {
    await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM connections WHERE id = ${connectionId} AND "spaceId" = ${context.spaceId} AND "userId" = ${context.userId} AND "connectorId" = 'computer' FOR UPDATE`;
      const current = await tx.connection.findFirstOrThrow({
        where: {
          id: connectionId,
          spaceId: context.spaceId,
          userId: context.userId,
          connectorId: "computer",
        },
      });
      if (current.updatedAt?.getTime() !== previous.updatedAt?.getTime())
        throw new ORPCError("CONFLICT", {
          message: "This computer changed. Reload and try again.",
        });
      await tx.connection.update({
        where: { id: connectionId },
        data: { displayName: input.name },
      });
      await tx.fleetAudit.create({
        data: { spaceId: context.spaceId, userId: context.userId, connectionId, action: "renamed" },
      });
    });
    return { changed: false };
  }
  if (
    changed &&
    !confirmActive &&
    (await deps.prisma.run.findFirst({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        status: { in: ["queued", "running", "waiting_input"] },
        bot: { computer: { connectionId } },
      },
      select: { id: true },
    }))
  )
    throw new ORPCError("CONFLICT", {
      message: "Runs are active on this computer. Confirm the connection change.",
    });

  if (input.settings.dockerContext && !input.settings.endpoint)
    throw new Error("Choose the saved context endpoint.");
  if (input.settings.engine === "ssh" && !input.settings.ssh)
    throw new Error("Choose an SSH host and user.");
  if (input.settings.engine !== "kubernetes" && (input.kubeconfig || input.kubeconfigPath))
    throw new Error("Kubeconfig is only used by Kubernetes.");

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
      const imported = await importFleetSecret(deps, { kubeconfig: source.inline }, context);
      input.settings.hostSecretId = imported.id;
    } else if (oldSettings.engine === "kubernetes")
      input.settings.hostSecretId = oldSettings.hostSecretId;
  } else if (input.privateKeyPath || input.tlsPaths) {
    const imported = await importFleetSecret(
      deps,
      { privateKeyPath: input.privateKeyPath, tlsPaths: input.tlsPaths },
      context,
    );
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

  await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM connections WHERE id = ${connectionId} AND "spaceId" = ${context.spaceId} AND "userId" = ${context.userId} AND "connectorId" = 'computer' FOR UPDATE`;
    const current = await tx.connection.findFirstOrThrow({
      where: {
        id: connectionId,
        spaceId: context.spaceId,
        userId: context.userId,
        connectorId: "computer",
      },
    });
    if (current.updatedAt?.getTime() !== previous.updatedAt?.getTime())
      throw new ORPCError("CONFLICT", { message: "This computer changed. Reload and try again." });
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
    await tx.connection.update({
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
  });
  if (oldSettings.hostSecretId && oldSettings.hostSecretId !== input.settings.hostSecretId) {
    const op = { op: "computer.remote.secret.delete" as const, secretId: oldSettings.hostSecretId };
    if (process.env.ARDURBOT_HOST_BRIDGE === "api" && deps.hostBridge)
      await deps.hostBridge.fleetResult(op, context);
    else await localFleetService().deleteSecret(oldSettings.hostSecretId);
  }
  return { changed };
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
  if (configuration.connectionId === null) {
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
