import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { FleetTarget } from "@ardurbot/contracts";
import {
  ComputerConnectionSettingsSchema,
  PlacementSettingsSchema,
  unknownCapacity,
} from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import type { ComputerSecretLoader } from "../computer-connections.js";
import { ComputerConnections } from "../computer-connections.js";
import { DockerSandboxProvider } from "../docker-sandbox.js";
import { createHostClient, usesHostBridge } from "../remote-host-sandbox.js";
import type { SandboxProviderOptions } from "../sandbox-factory.js";
import { hostCapacity } from "./service.js";

export class FleetCatalog {
  readonly connections: ComputerConnections;
  private readonly diagnostics = new Map<string, { version?: string; os?: string }>();
  recordTest(id: string, details: { version?: string; os?: string }) {
    this.diagnostics.set(id, details);
  }
  private readonly docker: DockerSandboxProvider;
  constructor(
    private readonly prisma: PrismaClient,
    secrets: ComputerSecretLoader,
    private readonly options: SandboxProviderOptions,
  ) {
    this.connections = new ComputerConnections(prisma, secrets, options);
    this.docker = new DockerSandboxProvider(
      options.supervisorUrl ?? "http://127.0.0.1:7091",
      options.supervisorToken,
    );
  }
  async testDefault(context: AdapterContext) {
    const info = await this.docker.engineInfo({
      ...context,
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(10000)]),
    });
    this.recordTest("default", { version: info.version, os: info.os });
  }
  async list(context: AdapterContext) {
    const [rows, bots, space, deployment] = await Promise.all([
      this.prisma.connection.findMany({
        where: { spaceId: context.spaceId, userId: context.userId, connectorId: "computer" },
        take: 128,
      }),
      this.prisma.bot.findMany({
        where: { spaceId: context.spaceId, userId: context.userId, archivedAt: null },
        include: { computer: true },
      }),
      this.prisma.space.findUniqueOrThrow({
        where: { id: context.spaceId },
        select: { placement: true },
      }),
      this.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
    ]);
    const host = usesHostBridge()
      ? await (this.options.hostClient ?? createHostClient()).health().catch(() => null)
      : null;
    const hostSnapshot = usesHostBridge()
      ? (host?.capacity ?? unknownCapacity())
      : await hostCapacity();
    const targets: FleetTarget[] = [
      {
        id: "host",
        name: "This Mac",
        kind: "host",
        connectionId: null,
        state: usesHostBridge() && !host ? "unavailable" : "connected",
        capacity: hostSnapshot,
        bots: [],
      },
    ];
    // Keep the deployment default visible even when the owner has selected a host computer.
    let dockerState: FleetTarget["state"] = "connected";
    const dockerSnapshot = await this.docker.capacity().catch(() => {
      dockerState = "unavailable";
      return unknownCapacity();
    });
    targets.push({
      ...this.diagnostics.get("default"),
      id: "default",
      name: "Docker on this Mac",
      kind: "docker",
      connectionId: null,
      state: dockerSnapshot.source === "not-reported" ? "unavailable" : dockerState,
      capacity: dockerSnapshot,
      bots: [],
    });
    // Four probes at a time bound host bridge and process load for larger fleets.
    for (let offset = 0; offset < rows.length; offset += 4) {
      const entries = await Promise.all(
        rows.slice(offset, offset + 4).map(async (row): Promise<FleetTarget> => {
          const settings = ComputerConnectionSettingsSchema.parse(row.metadata);
          let state: FleetTarget["state"] =
            row.status === "connected" ? "connected" : "unavailable";
          const capacity = await this.connections
            .resolve(row.id, context)
            .then((provider) => provider.capacity?.(context) ?? unknownCapacity())
            .catch(() => {
              state = "unavailable";
              return unknownCapacity();
            });
          if (capacity.source === "not-reported" && settings.engine !== "kubernetes")
            state = "unavailable";
          return {
            ...this.diagnostics.get(row.id),
            id: row.id,
            name: row.displayName,
            kind: settings.engine,
            connectionId: row.id,
            state,
            capacity,
            endpoint: settings.endpoint ?? settings.socket,
            context: settings.context,
            ssh: settings.ssh,
            bots: [],
          };
        }),
      );
      targets.push(...entries);
    }
    for (const bot of bots) {
      const targetId =
        bot.computer?.connectionId ??
        (bot.computer?.kind === "desktop" || deployment?.computerHost === "this-mac"
          ? "host"
          : "default");
      targets.find((target) => target.id === targetId)?.bots.push({ id: bot.id, name: bot.name });
    }
    // The null binding means the saved deployment default. Do not silently change it to reach a host.
    const defaultTargetId = deployment?.computerHost === "this-mac" ? "host" : "default";
    return {
      targets,
      bots,
      placement: PlacementSettingsSchema.parse(space.placement ?? {}),
      defaultTargetId,
    };
  }
}
