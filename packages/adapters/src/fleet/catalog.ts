import type { AdapterContext, SandboxProvider } from "@ardurbot/adapter-kit";
import type { FleetTarget } from "@ardurbot/contracts";
import { ComputerConnectionSettingsSchema, thisMacUnavailableMessage } from "@ardurbot/contracts";
import { PlacementSettingsSchema, unknownCapacity } from "@ardurbot/contracts/fleet";
import type { PrismaClient } from "@ardurbot/db";
import type { ComputerIdentity, ComputerSecretLoader } from "../computer-connections.js";
import { ComputerConnections, ConnectedSandboxProvider } from "../computer-connections.js";
import { DockerSandboxProvider } from "../docker-sandbox.js";
import type { ComputerRouter } from "../host-aware-sandbox.js";
import { isComputerRouter, sandboxKindForBot } from "../host-aware-sandbox.js";
import { createHostClient, usesHostBridge } from "../remote-host-sandbox.js";
import type { SandboxProviderOptions } from "../sandbox-factory.js";
import { hostCapacity } from "./service.js";

/** Built-in row for a computer with no saved connection. Local Docker keeps its own row. */
export function fleetComputerTargetId(
  computer: { connectionId?: string | null; kind?: string | null } | null | undefined,
  fleet: {
    defaultTargetId: string;
    targets: Array<{ id: string; kind: string; connectionId: string | null }>;
  },
): string {
  if (computer?.connectionId) return computer.connectionId;
  if (computer?.kind === "desktop") return "host";
  if (computer?.kind === "docker") {
    return (
      fleet.targets.find((target) => target.connectionId === null && target.kind === "docker")
        ?.id ?? fleet.defaultTargetId
    );
  }
  return fleet.defaultTargetId;
}

/** Local Docker and remote Docker (socket, endpoint, or context) are one family. */
export function placementEngineFamily(providerId: string): string {
  return providerId === "docker" || providerId === "remote-docker" ? "docker" : providerId;
}

export class FleetCatalog {
  readonly connections: ComputerConnections;
  private readonly diagnostics = new Map<string, { version?: string; os?: string }>();
  recordTest(id: string, details: { version?: string; os?: string }) {
    this.diagnostics.set(id, details);
  }
  private readonly docker: DockerSandboxProvider;
  private readonly routing: ComputerRouter;
  constructor(
    private readonly prisma: PrismaClient,
    secrets: ComputerSecretLoader,
    private readonly options: SandboxProviderOptions,
    private readonly fallback: SandboxProvider,
  ) {
    this.connections = new ComputerConnections(prisma, secrets, options);
    const docker = new DockerSandboxProvider(
      options.supervisorUrl ?? "http://127.0.0.1:7091",
      options.supervisorToken,
    );
    this.docker = docker;
    this.routing = isComputerRouter(fallback)
      ? fallback
      : new ConnectedSandboxProvider(fallback, this.connections, { docker: () => docker });
  }
  /** Same owner the run sandbox uses for every operation on this computer. */
  resolveComputer(computer: ComputerIdentity, context: AdapterContext): Promise<SandboxProvider> {
    return this.routing.owner(computer, context);
  }
  /** Built-in local rows hold one kind; connection rows and the default create new computers. */
  resolveTarget(
    target: Pick<FleetTarget, "kind" | "connectionId">,
    context: AdapterContext,
  ): Promise<SandboxProvider> {
    if (!target.connectionId && (target.kind === "host" || target.kind === "docker"))
      return this.resolveComputer({ kind: target.kind === "host" ? "desktop" : "docker" }, context);
    return this.routing.target(target, context);
  }
  async compatibleTargets(
    computer: ComputerIdentity,
    targets: FleetTarget[],
    context: AdapterContext,
  ): Promise<FleetTarget[]> {
    const sourceFamily = placementEngineFamily(
      (await this.resolveComputer(computer, context)).describe().id,
    );
    const compatible = await Promise.all(
      targets.map(async (target) => {
        const targetId = await this.resolveTarget(target, context)
          .then((provider) => provider.describe().id)
          .catch(() => null);
        return targetId && placementEngineFamily(targetId) === sourceFamily ? target : null;
      }),
    );
    return compatible.filter((target): target is FleetTarget => target !== null);
  }
  async resolveReplacementRouting(
    computer: ComputerIdentity,
    configuration: { connectionId?: string | null; targetId?: string; thisMac?: true },
    context: AdapterContext,
    listedFleet?: Awaited<ReturnType<FleetCatalog["list"]>>,
  ): Promise<{ source: SandboxProvider; target: SandboxProvider }> {
    const source = await this.resolveComputer(computer, context);
    if (configuration.targetId === undefined) {
      if (configuration.thisMac) throw new Error(thisMacUnavailableMessage);
      if (
        configuration.connectionId === undefined ||
        configuration.connectionId === computer.connectionId
      )
        return { source, target: source };
      // A Settings connection change is already confirmed and may cross kinds.
      // Deployment default is that engine, distinct from This Mac.
      const target = configuration.connectionId
        ? await this.routing.target({ connectionId: configuration.connectionId }, context)
        : await this.resolveComputer({ kind: this.fallback.describe().id }, context);
      return { source, target };
    }
    const row = (listedFleet ?? (await this.list(context))).targets.find(
      (candidate) => candidate.id === configuration.targetId,
    );
    const target = row && (await this.resolveTarget(row, context));
    // Automatic placement stays on one kind of computer until verified migration lands.
    if (
      !target ||
      placementEngineFamily(target.describe().id) !== placementEngineFamily(source.describe().id)
    )
      throw new Error("Computer replacement target is unavailable");
    return { source, target };
  }
  async testDefault(context: AdapterContext) {
    const deployment = await this.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
    });
    const kind = sandboxKindForBot(this.fallback.describe().id, deployment?.computerHost);
    // The null binding refreshes both local rows when the default is the host.
    if (kind !== "docker" && kind !== "desktop") {
      await this.fallback.capacity(context);
      return;
    }
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
    const defaultKind = sandboxKindForBot(this.fallback.describe().id, deployment?.computerHost);
    const defaultTargetId = defaultKind === "desktop" ? "host" : "default";
    const defaultCapacity = await this.fallback
      .capacity({
        ...context,
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(10000)]),
      })
      .catch(() => unknownCapacity());
    const host = usesHostBridge()
      ? await (this.options.hostClient ?? createHostClient()).health().catch(() => null)
      : null;
    const hostSnapshot =
      defaultTargetId === "host"
        ? defaultCapacity
        : usesHostBridge()
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
    // Desktop already has a separate Docker row. Any other non-Docker default needs one too,
    // so a local Docker computer is not listed on the fallback's capacity.
    const defaultRowIsDocker = defaultTargetId === "host" || defaultKind === "docker";
    let dockerState: FleetTarget["state"] = "connected";
    const dockerSnapshot =
      defaultRowIsDocker && defaultTargetId === "default"
        ? defaultCapacity
        : await this.docker.capacity().catch(() => {
            dockerState = "unavailable";
            return unknownCapacity();
          });
    const dockerRow = {
      id: defaultRowIsDocker ? "default" : "docker",
      name: "Docker on this Mac",
      kind: "docker" as const,
      connectionId: null,
      state: (dockerSnapshot.source === "not-reported"
        ? "unavailable"
        : dockerState) as FleetTarget["state"],
      capacity: dockerSnapshot,
      bots: [],
    };
    if (defaultRowIsDocker) {
      targets.push({ ...this.diagnostics.get("default"), ...dockerRow });
    } else {
      targets.push({
        ...this.diagnostics.get("default"),
        id: "default",
        name: "Default computer",
        kind: defaultKind === "kubernetes" ? "kubernetes" : "default",
        connectionId: null,
        state: defaultCapacity.source === "not-reported" ? "unavailable" : "connected",
        capacity: defaultCapacity,
        bots: [],
      });
      targets.push(dockerRow);
    }
    // Bound per-list work; the shared host bridge also reserves slots for execution.
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
      const targetId = fleetComputerTargetId(bot.computer, { defaultTargetId, targets });
      targets.find((target) => target.id === targetId)?.bots.push({ id: bot.id, name: bot.name });
    }
    // A null binding keeps the computer's own kind. Do not silently change it to reach a host.
    return {
      targets,
      bots,
      placement: PlacementSettingsSchema.parse(space.placement ?? {}),
      defaultTargetId,
    };
  }
}
