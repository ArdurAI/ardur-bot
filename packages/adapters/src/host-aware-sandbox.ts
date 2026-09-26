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
import { ComputerConnections, ConnectedSandboxProvider } from "./computer-connections.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
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
      : new DesktopSandboxProvider({ root: opts.dataDir, hostRoots: [homedir()] }),
  );
  const selected = kind === "desktop" ? host() : createSandboxProvider(kind, opts);
  // Connectionless computers keep the engine of their kind; a hosted one needs its key here.
  const local: Partial<Record<string, () => SandboxProvider>> = {
    docker: once(() => createSandboxProvider("docker", opts)),
    desktop: host,
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
      this.pageBrowser = (computer, request, context) => {
        const provider = this.route(computer);
        return provider.pageBrowser
          ? provider.pageBrowser(computer, request, context)
          : Promise.resolve({
              ok: false,
              uncertain: false,
              fallback: "computer_act",
              error: "Page browser is unavailable on this computer.",
            });
      };
    }
  }

  async capacity(context: AdapterContext) {
    return this.route({}, await this.hostEnabled()).capacity?.(context) ?? unknownCapacity();
  }

  describe() {
    return this.isolated.describe();
  }

  /**
   * A saved kind routes itself: desktop to This Mac, anything else to its own provider.
   * Pass the This Mac setting only while choosing a computer that has no saved kind yet.
   */
  private route(subject: ComputerIdentity, hostSelected?: boolean) {
    return !subject.connectionId && (hostSelected ?? subject.kind === "desktop")
      ? this.host
      : this.isolated;
  }

  owner(computer: ComputerIdentity, context: AdapterContext): Promise<SandboxProvider> {
    return owningSandbox(this.route(computer), computer, context);
  }

  /** Reads This Mac once, so a move provisions where it was checked. */
  async target(
    subject: { connectionId?: string | null },
    context: AdapterContext,
  ): Promise<SandboxProvider> {
    const provider = this.route(subject, await this.hostEnabled());
    return isComputerRouter(provider) ? provider.target(subject, context) : provider;
  }

  async supportsNetworkEgress(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).supportsNetworkEgress?.(computer, context) ?? false;
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
    return this.route(
      { connectionId: request.connectionId, kind: savedKind },
      savedKind ? undefined : await this.hostEnabled(),
    ).provision(request, context);
  }

  prepare(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).prepare(computer, context);
  }

  async environmentNote(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).environmentNote?.(computer, context);
  }

  async resolveCommandCwd(...args: Parameters<NonNullable<SandboxProvider["resolveCommandCwd"]>>) {
    return this.route(args[0]).resolveCommandCwd?.(...args) ?? null;
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    yield* this.route(computer).execute(computer, request, context);
  }

  connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return this.route(computer).connectScreen(computer, request, context);
  }

  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return this.route(computer).sendInput(computer, input, lease, context);
  }

  observe(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).observe(computer, context);
  }

  act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.route(computer).act(computer, request, context);
  }

  listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return this.route(computer).listFiles(computer, path, context);
  }

  readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number; preview?: boolean },
  ) {
    return this.route(computer).readFile(computer, path, context, options);
  }

  writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    return this.route(computer).writeFile(computer, file, context);
  }

  exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).exportWorkspace(computer, context);
  }

  importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    return this.route(computer).importWorkspace(computer, files, context);
  }

  snapshot(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).snapshot(computer, context);
  }

  keepAlive(computer: ComputerRef) {
    return this.route(computer).keepAlive?.(computer) ?? Promise.resolve();
  }

  releaseScreen(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).releaseScreen?.(computer, context) ?? Promise.resolve();
  }

  setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    return (
      this.route(computer).setScreenControl?.(computer, interactive, context, controlToken) ??
      Promise.resolve()
    );
  }

  stop(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).stop(computer, context);
  }

  destroy(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).destroy(computer, context);
  }
}
