import { homedir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { EncryptedSecretStore } from "@ardurbot/adapters";
import { DockerSandboxProvider, kubernetesContexts, snapshotKubeconfig } from "@ardurbot/adapters";
import {
  ComputerConfigurationSchema,
  ComputerConnectionInputSchema,
  ComputerConnectionSettingsSchema,
  ComputerEngineUnavailableError,
} from "@ardurbot/contracts";
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
    settings: ComputerConnectionSettingsSchema.parse(row.metadata),
  }));
}
export async function saveComputerConnection(
  deps: { prisma: PrismaClient; secrets: EncryptedSecretStore; hostBridge?: HostBridge },
  raw: z.infer<typeof ComputerConnectionInputSchema>,
  context: AdapterContext,
) {
  const input = ComputerConnectionInputSchema.parse(raw);
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
export async function validateComputerConfiguration(
  prisma: PrismaClient,
  spaceId: string,
  raw: z.infer<typeof ComputerConfigurationSchema>,
) {
  const configuration = ComputerConfigurationSchema.parse(raw);
  if (!configuration.confirmed) throw new Error("This replaces the computer's files. Continue?");
  if (
    configuration.connectionId &&
    !(await prisma.connection.findFirst({
      where: { id: configuration.connectionId, spaceId, connectorId: "computer" },
    }))
  )
    throw new Error("Choose an available computer connection.");
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
