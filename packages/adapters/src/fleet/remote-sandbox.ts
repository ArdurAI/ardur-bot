import type {
  AdapterContext,
  CommandRequest,
  ComputerFileEntry,
  ComputerObservation,
  ComputerRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  TerminalContext,
  TerminalProvider,
} from "@ardurbot/adapter-kit";
import type { ComputerConnectionSettings, RemoteComputerAction } from "@ardurbot/contracts";
import { CapacitySnapshotSchema, unknownCapacity } from "@ardurbot/contracts/fleet";
import { HOST_FILE_BYTES } from "@ardurbot/contracts/host-bridge";
import {
  FLEET_LINUX_CAPABILITIES,
  fleetComputerKey,
} from "@ardurbot/host-runtime/fleet/linux-sandbox";
import type { HostClient } from "@ardurbot/host-runtime/host-client";

export class RemoteFleetSandbox implements SandboxProvider {
  readonly terminal: TerminalProvider;
  constructor(
    private readonly connectionId: string,
    private readonly settings: ComputerConnectionSettings,
    private readonly client: Pick<HostClient, "request">,
  ) {
    const sessions = new Map<string, { computer: ComputerRef; context: TerminalContext }>();
    const session = (id: string) => {
      const found = sessions.get(id);
      if (!found) throw new Error("Terminal session is unavailable.");
      return found;
    };
    this.terminal = {
      open: async (computer, options, context) => {
        const result = (await this.result(
          computer.botId,
          {
            type: "terminal.open",
            ...options,
            leaseId: context.leaseId,
            fence: context.fence,
            generation: context.generation,
            expiresAt: context.expiresAt,
            workingRoot: context.workingRoot,
          },
          context,
        )) as { id: string; generation: string };
        sessions.set(result.id, { computer, context });
        return result;
      },
      write: async (id, bytes) => {
        const { computer, context } = session(id);
        await this.result(
          computer.botId,
          {
            type: "terminal.write",
            sessionId: id,
            leaseId: context.leaseId,
            content: Buffer.from(bytes).toString("base64"),
          },
          context,
        );
      },
      resize: async (id, cols, rows) => {
        const { computer, context } = session(id);
        await this.result(
          computer.botId,
          { type: "terminal.resize", sessionId: id, leaseId: context.leaseId, cols, rows },
          context,
        );
      },
      close: async (id) => {
        const { computer, context } = session(id);
        await this.result(
          computer.botId,
          { type: "terminal.close", sessionId: id, leaseId: context.leaseId },
          context,
        );
        sessions.delete(id);
      },
      output: (id) => {
        const { computer, context } = session(id);
        return this.terminalOutput(computer, id, context);
      },
      revoke: async (computer, leaseId, context) => {
        await this.result(computer.botId, { type: "terminal.revoke", leaseId }, context);
        for (const [id, value] of sessions)
          if (value.computer.id === computer.id && value.context.leaseId === leaseId)
            sessions.delete(id);
      },
    };
  }
  private get kind() {
    return this.settings.engine === "ssh" ? ("ssh" as const) : ("remote-docker" as const);
  }
  describe() {
    return {
      id: this.kind,
      kind: this.kind,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: FLEET_LINUX_CAPABILITIES,
    };
  }
  private request(homeKey: string, action: RemoteComputerAction, context: AdapterContext) {
    return this.client.request(
      {
        op: "computer.remote.call",
        homeKey,
        connectionId: this.connectionId,
        settings: this.settings,
        action,
        ...(context.runId ? {} : { maintenanceId: context.operationId }),
      },
      context,
    );
  }
  private async result(homeKey: string, action: RemoteComputerAction, context: AdapterContext) {
    let result: unknown;
    for await (const frame of this.request(homeKey, action, context))
      if (frame.channel === "result") result = frame.data;
    return result;
  }
  async capacity(context: AdapterContext) {
    return CapacitySnapshotSchema.parse(
      (await this.result("capacity", { type: "capacity" }, context)) ?? unknownCapacity(),
    );
  }
  async test(context: AdapterContext) {
    return this.result("capacity", { type: "test" }, context);
  }
  async supportsNetworkEgress() {
    return this.settings.engine === "docker" || this.settings.engine === "podman";
  }
  async provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    return (await this.result(
      request.botId,
      {
        type: "provision",
        imageProfile: request.imageProfile ?? "base",
        networkEgress: request.networkEgress,
      },
      context,
    )) as ComputerRef;
  }
  async prepare(computer: ComputerRef, context: AdapterContext) {
    await this.result(computer.botId, { type: "prepare" }, context);
  }
  async resolveCommandCwd(computer: ComputerRef, cwd: string | undefined, context: AdapterContext) {
    return (await this.result(computer.botId, { type: "cwd", cwd }, context)) as string;
  }
  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    for await (const frame of this.request(computer.botId, { type: "exec", ...request }, context)) {
      if (frame.channel === "stdout" || frame.channel === "stderr")
        yield { type: frame.channel, data: String(frame.data) };
      else if (frame.channel === "exit") yield { type: "exit", code: Number(frame.data) };
    }
  }
  async connectScreen() {
    return { url: null, mimeType: "text/html", close: async () => undefined };
  }
  async observe(): Promise<ComputerObservation> {
    throw new Error("Not available on this computer");
  }
  async act(): Promise<never> {
    throw new Error("Not available on this computer");
  }
  async sendInput(): Promise<never> {
    throw new Error("Not available on this computer");
  }
  async listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return (await this.result(
      computer.botId,
      { type: "files.list", path },
      context,
    )) as ComputerFileEntry[];
  }
  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number; preview?: boolean },
  ) {
    const bytes: Buffer[] = [];
    for await (const frame of this.request(
      computer.botId,
      {
        type: "files.read",
        path,
        preview: options?.preview,
        maxBytes: Math.min(options?.maxBytes ?? HOST_FILE_BYTES, HOST_FILE_BYTES),
      },
      context,
    ))
      if (frame.channel === "file") bytes.push(Buffer.from(String(frame.data), "base64"));
    return new Uint8Array(Buffer.concat(bytes));
  }
  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    if (file.content.length > HOST_FILE_BYTES) throw new Error("Host file exceeds limit.");
    await this.result(
      computer.botId,
      {
        type: "files.write",
        path: file.path,
        content: Buffer.from(file.content).toString("base64"),
        executable: file.executable,
      },
      context,
    );
  }
  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    for await (const frame of this.request(computer.botId, { type: "export" }, context))
      if (frame.channel === "file") {
        const file = frame.data as { path: string; content: string; executable?: boolean };
        yield { ...file, content: Buffer.from(file.content, "base64") };
      }
  }
  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) await this.writeFile(computer, file, context);
  }
  async snapshot(computer: ComputerRef, context: AdapterContext) {
    return (await this.result(computer.botId, { type: "snapshot" }, context)) as {
      id: string;
      createdAt: string;
    };
  }
  async stop(computer: ComputerRef, context: AdapterContext) {
    await this.result(computer.botId, { type: "sleep" }, context);
  }
  async destroy(computer: ComputerRef, context: AdapterContext) {
    await this.result(computer.botId, { type: "destroy" }, context);
  }
  private async *terminalOutput(computer: ComputerRef, id: string, context: TerminalContext) {
    for await (const frame of this.request(
      computer.botId,
      { type: "terminal.output", sessionId: id, leaseId: context.leaseId },
      context,
    ))
      if (frame.channel === "result") {
        const output = frame.data as { seq: number; content: string };
        yield { seq: output.seq, bytes: Buffer.from(output.content, "base64") };
      }
  }
}

export { fleetComputerKey };
