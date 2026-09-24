import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { EncryptedSecretStore } from "@ardurbot/adapters";
import { DockerSandboxProvider, kubernetesContexts, snapshotKubeconfig } from "@ardurbot/adapters";
import {
  ComputerConfigurationSchema,
  ComputerConnectionInputSchema,
  ComputerConnectionSettingsSchema,
} from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import type { z } from "zod";

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
  deps: { prisma: PrismaClient; secrets: EncryptedSecretStore },
  raw: z.infer<typeof ComputerConnectionInputSchema>,
  context: AdapterContext,
) {
  const input = ComputerConnectionInputSchema.parse(raw);
  let source = { inline: input.kubeconfig, path: input.kubeconfigPath };
  if (input.settings.engine === "kubernetes") {
    if (Boolean(source.inline) === Boolean(source.path))
      throw new Error("Choose either a kubeconfig path or its contents.");
    const snapshot = await snapshotKubeconfig(source);
    source = { inline: snapshot.inline, path: snapshot.path };
    const contexts = await kubernetesContexts(source);
    if (!contexts.some((entry) => entry.name === input.settings.context))
      throw new Error("Choose a Kubernetes context.");
  } else if (
    input.kubeconfig ||
    input.kubeconfigPath ||
    (input.settings.socket && !/^(?:unix:\/\/)?\//.test(input.settings.socket))
  )
    throw new Error("Choose a local engine socket.");
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
  if (settings?.engine === "kubernetes") return { name: "kubernetes" as const, rootless: false };
  const provider = new DockerSandboxProvider(
    deps.env.sandboxSupervisorUrl ?? "http://127.0.0.1:7091",
    deps.env.sandboxSupervisorToken,
    settings
      ? { name: settings.engine as "docker" | "podman", socket: settings.socket }
      : undefined,
  );
  return provider.engineInfo(context);
}
