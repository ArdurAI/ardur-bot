import type {
  AdapterContext,
  ComputerRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import type {
  CapacitySnapshot,
  ComputerConnectionSettings,
  RemoteComputerAction,
} from "@ardurbot/contracts";
import type { HostClient } from "@ardurbot/host-runtime/host-client";
import type { KubernetesApi, KubernetesObject } from "../kubernetes-client.js";
import { KubernetesSandboxProvider } from "../kubernetes-sandbox.js";

export class HostKubernetesSandboxProvider implements SandboxProvider {
  private cached?: { expires: number; value: Promise<CapacitySnapshot> };
  constructor(
    private readonly connectionId: string,
    private readonly settings: ComputerConnectionSettings,
    private readonly client: Pick<HostClient, "request">,
  ) {}
  private request(homeKey: string, action: RemoteComputerAction, context: AdapterContext) {
    return this.client.request(
      {
        op: "computer.remote.call",
        homeKey,
        connectionId: this.connectionId,
        settings: this.settings,
        action,
        maintenanceId: context.operationId,
      },
      context,
    );
  }
  private provider(homeKey: string, context: AdapterContext) {
    const result = async (action: RemoteComputerAction, signal = context.signal) => {
      let output: unknown;
      for await (const frame of this.request(homeKey, action, { ...context, signal }))
        if (frame.channel === "result") output = frame.data;
      return output;
    };
    const request = this.request.bind(this);
    const api: KubernetesApi = {
      read: async (resource, name, signal) =>
        (await result({ type: "kube.read", resource, name }, signal)) as KubernetesObject | null,
      create: async (resource, body, signal) => {
        await result({ type: "kube.create", resource, body }, signal);
      },
      remove: async (resource, name, signal) => {
        await result({ type: "kube.remove", resource, name }, signal);
      },
      capacity: async () =>
        (await result({ type: "kube.capacity" })) as Awaited<
          ReturnType<NonNullable<KubernetesApi["capacity"]>>
        >,
      namespaces: async () => (await result({ type: "kube.namespaces" })) as string[],
      async *exec(name, argv, signal, input): AsyncIterable<ProcessEvent> {
        if (input && input.length > 128 * 1024) throw new Error("Host file exceeds limit.");
        for await (const frame of request(
          homeKey,
          {
            type: "kube.exec",
            name,
            argv,
            ...(input ? { input: Buffer.from(input).toString("base64") } : {}),
          },
          { ...context, signal },
        )) {
          if (frame.channel === "stdout" || frame.channel === "stderr")
            yield { type: frame.channel, data: String(frame.data) };
          else if (frame.channel === "exit") yield { type: "exit", code: Number(frame.data) };
        }
      },
    };
    return new KubernetesSandboxProvider(api, this.settings);
  }
  describe() {
    return {
      id: "kubernetes",
      kind: "kubernetes" as const,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: false,
        pty: false,
        interactiveTerminal: false,
        snapshots: true,
        takeover: false,
        persistentHome: true,
        multiScreen: false,
      },
    };
  }
  capacity(context: AdapterContext) {
    if (!this.cached || this.cached.expires <= Date.now())
      this.cached = {
        expires: Date.now() + 30000,
        value: this.provider("capacity", context).capacity(),
      };
    return this.cached.value;
  }
  namespaces(context: AdapterContext) {
    return this.provider("capacity", context).namespaces();
  }
  async test(context: AdapterContext) {
    let version = "Kubernetes";
    for await (const frame of this.request("capacity", { type: "kube.version" }, context))
      if (frame.channel === "result") version = String(frame.data);
    return { capacity: await this.capacity(context), os: "Linux", version };
  }
  provision(request: Parameters<SandboxProvider["provision"]>[0], context: AdapterContext) {
    return this.provider(request.botId, context).provision(request, context);
  }
  prepare(computer: ComputerRef, context: AdapterContext) {
    return this.provider(computer.botId, context).prepare(computer, context);
  }
  resolveCommandCwd(computer: ComputerRef, cwd: string | undefined, context: AdapterContext) {
    return this.provider(computer.botId, context).resolveCommandCwd(computer, cwd);
  }
  execute(
    computer: ComputerRef,
    request: Parameters<SandboxProvider["execute"]>[1],
    context: AdapterContext,
  ) {
    return this.provider(computer.botId, context).execute(computer, request, context);
  }
  async connectScreen() {
    return { url: null, mimeType: "text/html", close: async () => undefined };
  }
  async observe(): Promise<never> {
    throw new Error("Not available on this computer");
  }
  async act(): Promise<never> {
    throw new Error("Not available on this computer");
  }
  async sendInput(): Promise<never> {
    throw new Error("Not available on this computer");
  }
  listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return this.provider(computer.botId, context).listFiles(computer, path, context);
  }
  readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number; preview?: boolean },
  ) {
    return this.provider(computer.botId, context).readFile(computer, path, context, options);
  }
  writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    return this.provider(computer.botId, context).writeFile(computer, file, context);
  }
  exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    return this.provider(computer.botId, context).exportWorkspace(computer, context);
  }
  importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    return this.provider(computer.botId, context).importWorkspace(computer, files, context);
  }
  snapshot(computer: ComputerRef, context: AdapterContext) {
    return this.provider(computer.botId, context).snapshot(computer);
  }
  stop(computer: ComputerRef, context: AdapterContext) {
    return this.provider(computer.botId, context).stop(computer, context);
  }
  destroy(computer: ComputerRef, context: AdapterContext) {
    return this.provider(computer.botId, context).destroy(computer, context);
  }
}
