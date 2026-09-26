import { homedir } from "node:os";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
} from "@ardurbot/adapter-kit";
import { unknownCapacity } from "@ardurbot/contracts/fleet";
import type { PrismaClient } from "@ardurbot/db";
import type { ComputerIdentity, ComputerSecretLoader } from "./computer-connections.js";
import {
  ComputerConnections,
  ConnectedSandboxProvider,
  MissingComputerProviderError,
} from "./computer-connections.js";
import { localDesktopSandbox } from "./desktop-sandbox.js";
import {
  createHostClient,
  RemoteHostSandboxProvider,
  usesHostBridge,
} from "./remote-host-sandbox.js";
import type { SandboxProviderOptions } from "./sandbox-factory.js";
import { createSandboxProvider } from "./sandbox-factory.js";

export function sandboxKindForBot(envKind: string, computerHost: string | null | undefined) {
  if (envKind === "docker" && computerHost === "this-mac") return "desktop";
  return envKind;
}

function once<T>(create: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= create());
}

export function createRunSandbox(
  kind: string,
  opts: SandboxProviderOptions & { prisma?: PrismaClient; secrets?: ComputerSecretLoader },
): SandboxProvider {
  // Other engines are built on first use: a non-Docker deployment may have no supervisor token.
  const host = once(() =>
    usesHostBridge()
      ? new RemoteHostSandboxProvider(opts.hostClient ?? createHostClient())
      : localDesktopSandbox(opts.dataDir, [homedir()]),
  );
  const selected = kind === "desktop" ? host() : createSandboxProvider(kind, opts);
  // Connectionless computers keep the engine of their kind; a hosted one needs its key here.
  // The host is never one of these: only a desktop deployment, or Docker with This Mac on, has it.
  const local: Partial<Record<string, () => SandboxProvider>> = {
    docker: once(() => createSandboxProvider("docker", opts)),
  };
  for (const [hosted, key] of [
    ["e2b", opts.e2bApiKey],
    ["daytona", opts.daytonaApiKey],
    ["box", opts.boxApiKey],
  ] as const)
    if (key?.trim()) local[hosted] = once(() => createSandboxProvider(hosted, opts));
  const primary =
    opts.prisma && opts.secrets
      ? new ConnectedSandboxProvider(
          selected,
          new ComputerConnections(opts.prisma, opts.secrets, opts),
          local,
        )
      : selected;
  if (kind !== "docker" || !opts.prisma) return primary;
  return new HostAwareSandbox(primary, host(), async () => {
    const settings = await opts.prisma!.deploymentSettings.findUnique({
      where: { id: "default" },
    });
    return settings?.computerHost === "this-mac";
  });
}

export type ComputerRouter = HostAwareSandbox | ConnectedSandboxProvider;

export function isComputerRouter(provider: SandboxProvider): provider is ComputerRouter {
  return provider instanceof HostAwareSandbox || provider instanceof ConnectedSandboxProvider;
}

/** The concrete provider that owns an existing computer. */
export function owningSandbox(
  provider: SandboxProvider,
  computer: ComputerIdentity,
  context: AdapterContext,
): Promise<SandboxProvider> {
  return isComputerRouter(provider) ? provider.owner(computer, context) : Promise.resolve(provider);
}

export class HostAwareSandbox implements SandboxProvider {
  get terminal() {
    return this.isolated.terminal;
  }

  readonly pageBrowser?: SandboxProvider["pageBrowser"];

  constructor(
    private readonly isolated: SandboxProvider,
    private readonly host: SandboxProvider,
    private readonly hostEnabled: () => Promise<boolean>,
  ) {
    if (isolated.pageBrowser || host.pageBrowser) {
      this.pageBrowser = async (computer, request, context) => {
        const provider = await this.route(computer);
        return provider.pageBrowser
          ? provider.pageBrowser(computer, request, context)
          : {
              ok: false,
              uncertain: false,
              fallback: "computer_act",
              error: "Page browser is unavailable on this computer.",
            };
      };
    }
  }

  async capacity(context: AdapterContext) {
    return (
      (await this.route({}, await this.hostEnabled())).capacity?.(context) ?? unknownCapacity()
    );
  }

  describe() {
    return this.isolated.describe();
  }

  /**
   * A saved kind routes itself: desktop to the host while This Mac is on, anything else to its
   * own provider. Pass the This Mac setting only while choosing where a new computer starts.
   */
  private async route(subject: ComputerIdentity, hostSelected?: boolean) {
    if (subject.connectionId) return this.isolated;
    if (hostSelected !== undefined) return hostSelected ? this.host : this.isolated;
    if (subject.kind !== "desktop") return this.isolated;
    if (await this.hostEnabled()) return this.host;
    throw new MissingComputerProviderError("desktop");
  }

  async owner(computer: ComputerIdentity, context: AdapterContext): Promise<SandboxProvider> {
    return owningSandbox(await this.route(computer), computer, context);
  }

  /** Reads This Mac once, so a move provisions where it was checked. */
  async target(
    subject: { connectionId?: string | null },
    context: AdapterContext,
  ): Promise<SandboxProvider> {
    const provider = await this.route(subject, await this.hostEnabled());
    return isComputerRouter(provider) ? provider.target(subject, context) : provider;
  }

  async supportsNetworkEgress(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).supportsNetworkEgress?.(computer, context) ?? false;
  }
  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
      connectionId?: string | null;
      imageProfile?: ComputerRef["imageProfile"];
      networkEgress?: boolean;
    },
    context: AdapterContext,
  ) {
    const savedKind = request.providerKind;
    const provider = await this.route(
      { connectionId: request.connectionId, kind: savedKind },
      savedKind ? undefined : await this.hostEnabled(),
    );
    return provider.provision(request, context);
  }

  async prepare(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).prepare(computer, context);
  }

  async environmentNote(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).environmentNote?.(computer, context);
  }

  async resolveCommandCwd(...args: Parameters<NonNullable<SandboxProvider["resolveCommandCwd"]>>) {
    return (await this.route(args[0])).resolveCommandCwd?.(...args) ?? null;
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    yield* (await this.route(computer)).execute(computer, request, context);
  }

  async connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return (await this.route(computer)).connectScreen(computer, request, context);
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return (await this.route(computer)).sendInput(computer, input, lease, context);
  }

  async observe(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).observe(computer, context);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return (await this.route(computer)).act(computer, request, context);
  }

  async listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return (await this.route(computer)).listFiles(computer, path, context);
  }

  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number; preview?: boolean },
  ) {
    return (await this.route(computer)).readFile(computer, path, context, options);
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    return (await this.route(computer)).writeFile(computer, file, context);
  }

  async *exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    yield* (await this.route(computer)).exportWorkspace(computer, context);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    return (await this.route(computer)).importWorkspace(computer, files, context);
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).snapshot(computer, context);
  }

  async keepAlive(computer: ComputerRef) {
    await (await this.route(computer)).keepAlive?.(computer);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext) {
    await (await this.route(computer)).releaseScreen?.(computer, context);
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    await (await this.route(computer)).setScreenControl?.(
      computer,
      interactive,
      context,
      controlToken,
    );
  }

  async stop(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).stop(computer, context);
  }

  async destroy(computer: ComputerRef, context: AdapterContext) {
    return (await this.route(computer)).destroy(computer, context);
  }
}
