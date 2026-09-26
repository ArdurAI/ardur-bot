import type { AdapterContext, SandboxProvider } from "@ardurbot/adapter-kit";
import type { FleetTarget, HostLabel } from "@ardurbot/contracts";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import {
  ENGINE_LABELS,
  FLEET_KINDS,
  PlacementSettingsSchema,
  unknownCapacity,
} from "@ardurbot/contracts/fleet";
import type { PrismaClient } from "@ardurbot/db";
import type { ComputerIdentity, ComputerSecretLoader } from "../computer-connections.js";
import { ComputerConnections, ConnectedSandboxProvider } from "../computer-connections.js";
import { DockerSandboxProvider } from "../docker-sandbox.js";
import type { ComputerRouter } from "../host-aware-sandbox.js";
import { isComputerRouter, sandboxKindForBot } from "../host-aware-sandbox.js";
import { createHostClient, usesHostBridge } from "../remote-host-sandbox.js";
import type { SandboxProviderOptions } from "../sandbox-factory.js";
import { hostCapacity } from "./service.js";

/** Kinds outside the fleet list, such as none and fake, belong to the default row. */
function fleetKind(kind: string | null | undefined): FleetTarget["kind"] {
  return FLEET_KINDS.find((known) => known === kind) ?? "default";
}

/** The paired desktop names the host; without one, the server running Ardur Bot does. */
export async function deploymentHostLabel(prisma: PrismaClient): Promise<HostLabel> {
  const paired = await prisma.hostRegistration.findUnique({
    where: { id: "default" },
    select: { platform: true },
  });
  return (paired?.platform ?? process.platform) === "darwin" ? "This Mac" : "This computer";
}

/** Built-in row for a computer with no saved connection. Each fleet kind keeps its own row. */
export function fleetComputerTargetId(
  computer: { connectionId?: string | null; kind?: string | null } | null | undefined,
  fleet: {
    defaultTargetId: string;
    targets: Array<{ id: string; kind: string; connectionId: string | null }>;
  },
): string {
  if (computer?.connectionId) return computer.connectionId;
  if (computer?.kind === "desktop") return "host";
  const kind = fleetKind(computer?.kind);
  if (kind === "default") return fleet.defaultTargetId;
  return (
    fleet.targets.find((target) => target.connectionId === null && target.kind === kind)?.id ??
    `kind:${kind}`
  );
}

/** Local Docker and remote Docker (socket, endpoint, or context) are one family. */
function placementEngineFamily(provider: SandboxProvider) {
  const kind = provider.describe().kind;
  return kind === "remote-docker" ? "docker" : kind;
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
    if (!target.connectionId && target.kind === "host")
      return this.resolveComputer({ kind: "desktop" }, context);
    if (!target.connectionId && target.kind !== "default")
      return this.resolveComputer({ kind: target.kind }, context);
    return this.routing.target(target, context);
  }
  /** An automatic move's destination. It stays in the computer's own engine family. */
  async placementTarget(
    computer: ComputerIdentity,
    target: Pick<FleetTarget, "kind" | "connectionId">,
    context: AdapterContext,
  ): Promise<SandboxProvider> {
    const [source, destination] = await Promise.all([
      this.resolveComputer(computer, context),
      this.resolveTarget(target, context),
    ]);
    if (placementEngineFamily(destination) !== placementEngineFamily(source))
      throw new Error("Computer replacement target is unavailable");
    return destination;
  }
  async compatibleTargets(
    computer: ComputerIdentity,
    targets: FleetTarget[],
    context: AdapterContext,
  ): Promise<FleetTarget[]> {
    const compatible = await Promise.all(
      targets.map((target) =>
        this.placementTarget(computer, target, context).then(
          () => target,
          () => null,
        ),
      ),
    );
    return compatible.filter((target): target is FleetTarget => target !== null);
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
  /** A row for connectionless computers of a kind this deployment runs beside its default. */
  private async kindTarget(
    kind: FleetTarget["kind"],
    context: AdapterContext,
  ): Promise<FleetTarget | null> {
    const provider = await this.resolveComputer({ kind }, context).catch(() => null);
    if (!provider) return null;
    const capacity = await provider
      .capacity({
        ...context,
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(10000)]),
      })
      .catch(() => unknownCapacity());
    return {
      id: `kind:${kind}`,
      name: ENGINE_LABELS[kind] ?? kind,
      kind,
      connectionId: null,
      state: capacity.source === "not-reported" ? "unavailable" : "connected",
      capacity,
      bots: [],
    };
  }
  async list(context: AdapterContext) {
    const [rows, bots, space, deployment, hostLabel] = await Promise.all([
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
      deploymentHostLabel(this.prisma),
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
        name: hostLabel,
        kind: "host",
        builtin: "host",
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
      name: hostLabel === "This Mac" ? "Docker on this Mac" : "Docker on this computer",
      kind: "docker" as const,
      builtin: "local-docker" as const,
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
        kind: fleetKind(this.fallback.describe().kind),
        builtin: "default",
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
    const kinds = new Set(
      bots.flatMap(({ computer }) =>
        computer && !computer.connectionId ? [fleetKind(computer.kind)] : [],
      ),
    );
    const kindRows = await Promise.all(
      [...kinds]
        .filter((kind) => {
          const id = fleetComputerTargetId({ kind }, { defaultTargetId, targets });
          return !targets.some((target) => target.id === id);
        })
        .map((kind) => this.kindTarget(kind, context)),
    );
    targets.push(...kindRows.filter((target): target is FleetTarget => target !== null));
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
      hostLabel,
    };
  }
}
