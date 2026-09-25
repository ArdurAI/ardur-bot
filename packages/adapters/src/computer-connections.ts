import type {
  AdapterContext,
  ComputerRef,
  SandboxProvider,
  TerminalProvider,
} from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { unknownCapacity } from "@ardurbot/contracts/fleet";
import type { PrismaClient } from "@ardurbot/db";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { HostKubernetesSandboxProvider } from "./fleet/remote-kubernetes.js";
import { RemoteFleetSandbox } from "./fleet/remote-sandbox.js";
import { localFleetService } from "./fleet/service.js";
import type { KubeconfigSource } from "./kubernetes-client.js";
import { createKubernetesApi } from "./kubernetes-client.js";
import { KubernetesSandboxProvider } from "./kubernetes-sandbox.js";
import { createHostClient, usesHostBridge } from "./remote-host-sandbox.js";
import type { SandboxProviderOptions } from "./sandbox-factory.js";

export type ComputerSecretLoader = { load(ciphertext: string, id: string): string };

/** Immutable connection rows keep every operation on the computer's saved destination. */
export class ComputerConnections {
  private readonly providers = new Map<string, Promise<SandboxProvider>>();
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: ComputerSecretLoader,
    private readonly options: SandboxProviderOptions,
  ) {}
  async resolve(id: string, context: AdapterContext) {
    const row = await this.prisma.connection.findFirst({
      where: { id, spaceId: context.spaceId, connectorId: "computer" },
    });
    if (!row)
      throw new Error("The computer connection is unavailable; choose a connection in Settings.");
    const key = `${context.spaceId}:${id}`;
    let provider = this.providers.get(key);
    if (!provider) {
      provider = (async () => {
        const settings = ComputerConnectionSettingsSchema.parse(row.metadata);
        if (settings.engine === "kubernetes" && settings.hostSecretId && usesHostBridge())
          return new HostKubernetesSandboxProvider(
            id,
            settings,
            this.options.hostClient ?? createHostClient(),
          );
        if (settings.engine === "ssh" || settings.endpoint || settings.dockerContext)
          return usesHostBridge()
            ? new RemoteFleetSandbox(id, settings, this.options.hostClient ?? createHostClient())
            : localFleetService().provider(id, settings, context.spaceId);
        if (settings.engine !== "kubernetes")
          return new DockerSandboxProvider(
            this.options.supervisorUrl ?? "http://127.0.0.1:7091",
            this.options.supervisorToken,
            { name: settings.engine, socket: settings.socket },
          );
        const secret = await this.prisma.secret.findFirst({
          where: { id: row.secretId ?? "", spaceId: context.spaceId, userId: row.userId },
        });
        if (!secret || !settings.context)
          throw new Error("Kubernetes credentials or context are unavailable.");
        const source = JSON.parse(
          this.secrets.load(secret.ciphertext, secret.id),
        ) as KubeconfigSource;
        return new KubernetesSandboxProvider(
          await createKubernetesApi(source, settings.namespace, settings.context),
          settings,
        );
      })();
      this.providers.set(key, provider);
      provider.catch(() => this.providers.delete(key));
    }
    return provider;
  }
}

export type ComputerIdentity = { connectionId?: string | null; kind?: string | null };

/** Engines that keep connectionless computers of their own kind under any deployment default. */
export type LocalSandboxes = {
  docker?: () => SandboxProvider;
  host?: () => SandboxProvider;
  providers?: Partial<Record<string, () => SandboxProvider>>;
};

const providerLabel: Record<string, string> = {
  kubernetes: "Kubernetes",
  e2b: "E2B",
  daytona: "Daytona",
  box: "Box",
};

/** One sentence naming the computer's kind and the provider that was not registered. */
export class MissingComputerProviderError extends Error {
  constructor(kind: string) {
    super(`No ${providerLabel[kind] ?? kind} provider is registered.`);
    this.name = "MissingComputerProviderError";
  }
}

export class ConnectedSandboxProvider implements SandboxProvider {
  readonly terminal: TerminalProvider;
  constructor(
    private readonly fallback: SandboxProvider,
    private readonly connections: ComputerConnections,
    private readonly local: LocalSandboxes = {},
  ) {
    const sessions = new Map<string, TerminalProvider>();
    const session = (id: string) => {
      const provider = sessions.get(id);
      if (!provider) throw new Error("Terminal session is unavailable.");
      return provider;
    };
    this.terminal = {
      open: async (computer, options, context) => {
        const provider = (await this.owner(computer, context)).terminal;
        if (!provider) throw new Error("Not available on this computer");
        const opened = await provider.open(computer, options, context);
        sessions.set(opened.id, provider);
        return opened;
      },
      write: (id, bytes) => session(id).write(id, bytes),
      resize: (id, cols, rows) => session(id).resize(id, cols, rows),
      close: async (id, reason) => {
        const provider = session(id);
        await provider.close(id, reason);
        sessions.delete(id);
      },
      output: (id) => session(id).output(id),
      revoke: async (computer, leaseId, context) => {
        await (await this.owner(computer, context)).terminal?.revoke(computer, leaseId, context);
      },
    };
  }
  keepAlive(computer: Parameters<NonNullable<SandboxProvider["keepAlive"]>>[0]) {
    return !computer.connectionId
      ? (this.connectionless(computer.kind).keepAlive?.(computer) ?? Promise.resolve())
      : Promise.resolve();
  }
  describe() {
    return this.fallback.describe();
  }
  /** Every operation on an existing computer: its connection, else the local engine of its kind. */
  owner(computer: ComputerIdentity, context: AdapterContext): Promise<SandboxProvider> {
    return computer.connectionId
      ? this.connections.resolve(computer.connectionId, context)
      : Promise.resolve(this.connectionless(computer.kind));
  }
  /** Where a new computer is created: the chosen connection, else the deployment default. */
  target(subject: { connectionId?: string | null }, context: AdapterContext) {
    return this.owner({ connectionId: subject.connectionId }, context);
  }
  private connectionless(kind: string | null | undefined) {
    const local =
      kind === "docker" ? this.local.docker : kind === "desktop" ? this.local.host : undefined;
    if (local) return local();
    const registered = kind ? this.local.providers?.[kind]?.() : undefined;
    if (registered) return registered;
    // A computer with no saved kind is created on the deployment default.
    if (!kind || this.fallback.describe().id === kind) return this.fallback;
    throw new MissingComputerProviderError(kind);
  }
  async capacity(context: AdapterContext) {
    return this.fallback.capacity?.(context) ?? unknownCapacity();
  }
  async targetCapacity(connectionId: string, context: AdapterContext) {
    return (
      (await this.connections.resolve(connectionId, context)).capacity?.(context) ??
      unknownCapacity()
    );
  }
  async supportsNetworkEgress(computer: ComputerRef, context: AdapterContext) {
    return (
      (await this.owner(computer, context)).supportsNetworkEgress?.(computer, context) ?? false
    );
  }
  async provision(request: Parameters<SandboxProvider["provision"]>[0], context: AdapterContext) {
    const provider = await this.owner(
      { connectionId: request.connectionId, kind: request.providerKind },
      context,
    );
    return {
      ...(await provider.provision(request, context)),
      connectionId: request.connectionId,
      imageProfile: request.imageProfile ?? "base",
    };
  }
  async prepare(...args: Parameters<SandboxProvider["prepare"]>) {
    return (await this.owner(args[0], args[1])).prepare(...args);
  }
  async environmentNote(...args: Parameters<NonNullable<SandboxProvider["environmentNote"]>>) {
    return (await this.owner(args[0], args[1])).environmentNote?.(...args);
  }
  async connectScreen(...args: Parameters<SandboxProvider["connectScreen"]>) {
    return (await this.owner(args[0], args[2])).connectScreen(...args);
  }
  async sendInput(...args: Parameters<SandboxProvider["sendInput"]>) {
    return (await this.owner(args[0], args[3])).sendInput(...args);
  }
  async observe(...args: Parameters<SandboxProvider["observe"]>) {
    return (await this.owner(args[0], args[1])).observe(...args);
  }
  async act(...args: Parameters<SandboxProvider["act"]>) {
    return (await this.owner(args[0], args[2])).act(...args);
  }
  async listFiles(...args: Parameters<SandboxProvider["listFiles"]>) {
    return (await this.owner(args[0], args[2])).listFiles(...args);
  }
  async readFile(...args: Parameters<SandboxProvider["readFile"]>) {
    return (await this.owner(args[0], args[2])).readFile(...args);
  }
  async writeFile(...args: Parameters<SandboxProvider["writeFile"]>) {
    return (await this.owner(args[0], args[2])).writeFile(...args);
  }
  async importWorkspace(...args: Parameters<SandboxProvider["importWorkspace"]>) {
    return (await this.owner(args[0], args[2])).importWorkspace(...args);
  }
  async snapshot(...args: Parameters<SandboxProvider["snapshot"]>) {
    return (await this.owner(args[0], args[1])).snapshot(...args);
  }
  async stop(...args: Parameters<SandboxProvider["stop"]>) {
    return (await this.owner(args[0], args[1])).stop(...args);
  }
  async destroy(...args: Parameters<SandboxProvider["destroy"]>) {
    return (await this.owner(args[0], args[1])).destroy(...args);
  }
  async *execute(...args: Parameters<SandboxProvider["execute"]>) {
    yield* (await this.owner(args[0], args[2])).execute(...args);
  }
  async *exportWorkspace(...args: Parameters<SandboxProvider["exportWorkspace"]>) {
    yield* (await this.owner(args[0], args[1])).exportWorkspace(...args);
  }
  async releaseScreen(...args: Parameters<NonNullable<SandboxProvider["releaseScreen"]>>) {
    return (await this.owner(args[0], args[1])).releaseScreen?.(...args) ?? undefined;
  }
  async setScreenControl(...args: Parameters<NonNullable<SandboxProvider["setScreenControl"]>>) {
    return (await this.owner(args[0], args[2])).setScreenControl?.(...args) ?? undefined;
  }
  async resolveCommandCwd(...args: Parameters<NonNullable<SandboxProvider["resolveCommandCwd"]>>) {
    return (await this.owner(args[0], args[2])).resolveCommandCwd?.(...args) ?? null;
  }
  async pageBrowser(...args: Parameters<NonNullable<SandboxProvider["pageBrowser"]>>) {
    const provider = await this.owner(args[0], args[2]);
    if (!provider.pageBrowser) throw new Error("Not available on this computer");
    return provider.pageBrowser(...args);
  }
}
