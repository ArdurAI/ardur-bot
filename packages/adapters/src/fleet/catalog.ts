import type { AdapterContext, SandboxProvider } from "@ardurbot/adapter-kit";
import type {
  CapacitySnapshot,
  ComputerConnectionSettings,
  FleetTarget,
  HostLabel,
} from "@ardurbot/contracts";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import {
  ENGINE_LABELS,
  FLEET_KINDS,
  PlacementSettingsSchema,
  unknownCapacity,
} from "@ardurbot/contracts/fleet";
import { sandboxKindForBot } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { engineFailureReason } from "@ardurbot/host-runtime/fleet/probe";
import type { ComputerIdentity, ComputerSecretLoader } from "../computer-connections.js";
import {
  ComputerConnections,
  ConnectedSandboxProvider,
  deploymentHostLabel,
} from "../computer-connections.js";
import { DockerSandboxProvider } from "../docker-sandbox.js";
import type { ComputerRouter } from "../host-aware-sandbox.js";
import { isComputerRouter } from "../host-aware-sandbox.js";
import { createHostClient, usesHostBridge } from "../remote-host-sandbox.js";
import type { SandboxProviderOptions } from "../sandbox-factory.js";
import { hostCapacity } from "./service.js";

/** Kinds outside the fleet list, such as none and fake, belong to the default row. */
function fleetKind(kind: string | null | undefined): FleetTarget["kind"] {
  return FLEET_KINDS.find((known) => known === kind) ?? "default";
}

/** Clarify only the old generated default; owner-chosen names remain untouched. */
export function projectedEngineName(
  name: string,
  settings: ComputerConnectionSettings,
  host: HostLabel,
): string {
  if (name !== "Docker on this Mac" && name !== "Docker on this computer") return name;
  const location = host === "This Mac" ? "this Mac" : "this computer";
  const endpoint = settings.endpoint ?? settings.socket;
  if (endpoint?.includes(".docker/run/docker.sock") || settings.dockerContext === "desktop-linux")
    return `Docker Desktop on ${location}`;
  if (endpoint?.includes(".orbstack/") || settings.dockerContext === "orbstack")
    return `OrbStack on ${location}`;
  const profile = /\.colima\/([^/]+)\/docker\.sock/.exec(endpoint ?? "")?.[1];
  if (profile) return `Colima (${profile}) on ${location}`;
  if (settings.dockerContext === "colima") return `Colima (default) on ${location}`;
  if (settings.dockerContext?.startsWith("colima-"))
    return `Colima (${settings.dockerContext.slice(7)}) on ${location}`;
  if (settings.dockerContext?.startsWith("kind-"))
    return `kind (${settings.dockerContext.slice(5)})`;
  return name;
}

/** Clusters and hosted providers report no capacity; a registered one is still available. */
function rowState(kind: string, capacity: CapacitySnapshot): FleetTarget["state"] {
  return capacity.source === "not-reported" &&
    !["kubernetes", "e2b", "daytona", "box"].includes(kind)
    ? "unavailable"
    : "connected";
}

/** Probes four at a time; the shared host bridge also reserves slots for execution. */
async function probeInBatches<T, R>(items: T[], probe: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += 4)
    results.push(...(await Promise.all(items.slice(offset, offset + 4).map(probe))));
  return results;
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
  // Host computers belong to the host row only where the host runs computers.
  if (computer?.kind === "desktop")
    return fleet.defaultTargetId === "host" ? "host" : "kind:desktop";
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
  private readonly diagnostics = new Map<
    string,
    Pick<FleetTarget, "version" | "os" | "reachability"> & { capacity?: CapacitySnapshot }
  >();
  recordTest(
    id: string,
    details: Pick<FleetTarget, "version" | "os" | "reachability"> & { capacity?: CapacitySnapshot },
  ) {
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
  /** The engine family an automatic move must stay in. */
  async engineFamily(computer: ComputerIdentity, context: AdapterContext) {
    return placementEngineFamily(await this.resolveComputer(computer, context));
  }
  /** An automatic move's destination. It stays in the source computer's engine family. */
  async placementTarget(
    family: string | null,
    target: Pick<FleetTarget, "kind" | "connectionId">,
    context: AdapterContext,
  ): Promise<SandboxProvider> {
    const destination = await this.resolveTarget(target, context);
    if (placementEngineFamily(destination) !== family)
      throw new Error("Computer replacement target is unavailable");
    return destination;
  }
  async compatibleTargets(
    family: string | null,
    targets: FleetTarget[],
    context: AdapterContext,
  ): Promise<FleetTarget[]> {
    const compatible = await probeInBatches(targets, (target) =>
      this.placementTarget(family, target, context).then(
        () => target,
        () => null,
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
    this.recordTest("default", {
      version: info.version,
      os: info.os,
      reachability: { status: "running", checkedAt: new Date().toISOString() },
    });
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
      state: rowState(kind, capacity),
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
    const previousDockerDiagnostic = this.diagnostics.get("default");
    const dockerDiagnostic =
      previousDockerDiagnostic?.reachability &&
      Date.now() - Date.parse(previousDockerDiagnostic.reachability.checkedAt) < 30_000
        ? previousDockerDiagnostic
        : undefined;
    const dockerRow = {
      id: defaultRowIsDocker ? "default" : "docker",
      name:
        hostLabel === "This Mac" ? "Docker engine on this Mac" : "Docker engine on this computer",
      kind: "docker" as const,
      builtin: "local-docker" as const,
      connectionId: null,
      state: (dockerDiagnostic?.reachability?.status === "installed-not-running"
        ? "unavailable"
        : dockerSnapshot.source === "not-reported"
          ? "unavailable"
          : dockerState) as FleetTarget["state"],
      reachability:
        dockerDiagnostic?.reachability ??
        (dockerSnapshot.source !== "not-reported"
          ? { status: "running" as const, checkedAt: new Date().toISOString() }
          : undefined),
      capacity: dockerSnapshot,
      bots: [],
    };
    if (defaultRowIsDocker) {
      targets.push({ ...this.diagnostics.get("default"), ...dockerRow });
    } else {
      const kind = fleetKind(this.fallback.describe().kind);
      targets.push({
        ...this.diagnostics.get("default"),
        id: "default",
        name: "Default computer",
        kind,
        builtin: "default",
        connectionId: null,
        state: rowState(kind, defaultCapacity),
        capacity: defaultCapacity,
        bots: [],
      });
      targets.push(dockerRow);
    }
    targets.push(
      ...(await probeInBatches(rows, async (row): Promise<FleetTarget> => {
        const settings = ComputerConnectionSettingsSchema.parse(row.metadata);
        let state: FleetTarget["state"] = row.status === "connected" ? "connected" : "unavailable";
        const diagnostic = this.diagnostics.get(row.id);
        const recent =
          diagnostic?.reachability &&
          Date.now() - Date.parse(diagnostic.reachability.checkedAt) < 30_000;
        let reachability = recent ? diagnostic.reachability : undefined;
        let capacity = await this.connections
          .resolve(row.id, context)
          .then((provider) => provider.capacity?.(context) ?? unknownCapacity())
          .catch(() => {
            state = "unavailable";
            return unknownCapacity();
          });
        capacity = (recent ? diagnostic?.capacity : undefined) ?? capacity;
        if (rowState(settings.engine, capacity) === "unavailable") {
          state = "unavailable";
          if (!reachability && (settings.engine === "docker" || settings.engine === "podman")) {
            const checkedAt = new Date().toISOString();
            try {
              const provider = await this.connections.resolve(row.id, context);
              if ("test" in provider && typeof provider.test === "function") {
                const details = (await provider.test({
                  ...context,
                  signal: AbortSignal.any([context.signal, AbortSignal.timeout(3000)]),
                })) as { capacity?: CapacitySnapshot };
                capacity = details.capacity ?? capacity;
                if (capacity.source !== "not-reported") state = "connected";
                reachability = { status: "running", checkedAt };
              }
            } catch (error) {
              reachability = {
                status:
                  settings.endpoint?.startsWith("ssh://") || settings.endpoint?.startsWith("tcp://")
                    ? "not-reachable"
                    : "installed-not-running",
                reason: engineFailureReason(error) ?? "not-reachable",
                checkedAt,
              };
            }
          }
        } else if (settings.engine === "docker" || settings.engine === "podman") {
          reachability = { status: "running", checkedAt: new Date().toISOString() };
        }
        if (reachability?.status === "running") state = "connected";
        if (reachability && reachability.status !== "running") state = "unavailable";
        return {
          ...this.diagnostics.get(row.id),
          id: row.id,
          name: projectedEngineName(row.displayName, settings, hostLabel),
          kind: settings.engine,
          connectionId: row.id,
          state,
          reachability,
          capacity,
          endpoint: settings.endpoint ?? settings.socket,
          context: settings.context,
          ssh: settings.ssh,
          bots: [],
        };
      })),
    );
    const kinds = new Set(
      bots.flatMap(({ computer }) =>
        computer && !computer.connectionId ? [fleetKind(computer.kind)] : [],
      ),
    );
    const kindRows = await probeInBatches(
      [...kinds].filter((kind) => {
        const id = fleetComputerTargetId({ kind }, { defaultTargetId, targets });
        return !targets.some((target) => target.id === id);
      }),
      (kind) => this.kindTarget(kind, context),
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
