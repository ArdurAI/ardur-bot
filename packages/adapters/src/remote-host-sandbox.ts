import type {
  AdapterContext,
  CommandRequest,
  ComputerFileEntry,
  ComputerRef,
  PortableFile,
  ProcessEvent,
} from "@ardurbot/adapter-kit";
import { unknownCapacity } from "@ardurbot/contracts";
import {
  HOST_FILE_BYTES,
  HostEnvironmentSchema,
  hostEnvironmentNote,
} from "@ardurbot/contracts/host-bridge";
import { resolveEncryptionKey } from "@ardurbot/core";
import { DesktopSandboxProvider } from "@ardurbot/host-runtime/desktop-sandbox";
import { HostClient } from "@ardurbot/host-runtime/host-client";

export function usesHostBridge(env: NodeJS.ProcessEnv = process.env) {
  return env.ARDURBOT_HOST_BRIDGE === "api";
}
export function createHostClient(env: NodeJS.ProcessEnv = process.env) {
  return new HostClient({
    apiUrl: env.API_INTERNAL_URL ?? env.API_URL ?? "http://127.0.0.1:3100",
    encryptionKey: resolveEncryptionKey(env),
  });
}
/** Only forwarding lives here. DesktopSandboxProvider inside the host owns execution. */
export class RemoteHostSandboxProvider extends DesktopSandboxProvider {
  constructor(private readonly client: Pick<HostClient, "request" | "result" | "health">) {
    super();
  }
  override async capacity() {
    return (await this.client.health())?.capacity ?? unknownCapacity();
  }

  override describe() {
    return { ...super.describe(), capabilities: { ...super.describe().capabilities, pty: false } };
  }
  override async provision(
    request: { botId: string; homePath: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    if (context.runId)
      await this.client.result(
        { op: "computer.lifecycle", homeKey: request.botId, action: "create" },
        context,
      );
    return {
      id: `host:${request.botId}`,
      botId: request.botId,
      kind: "desktop",
      providerRef: `host:${request.botId}`,
      fresh: false,
    };
  }
  override async prepare(computer: ComputerRef, context: AdapterContext) {
    if (context.runId) await this.lifecycle(computer, "prepare", context);
  }
  override async environmentNote(computer: ComputerRef, context: AdapterContext) {
    const environment = await this.client.result(
      { op: "computer.environment", homeKey: computer.botId },
      context,
    );
    return hostEnvironmentNote(HostEnvironmentSchema.parse(environment));
  }
  private lifecycle(
    computer: ComputerRef,
    action: "prepare" | "sleep" | "destroy" | "snapshot",
    context: AdapterContext,
  ) {
    return this.client.result(
      { op: "computer.lifecycle", homeKey: computer.botId, action },
      context,
    );
  }
  override async resolveCommandCwd(
    computer: ComputerRef,
    cwd: string | undefined,
    context: AdapterContext,
  ) {
    return (await this.client.result(
      { op: "computer.lifecycle", homeKey: computer.botId, action: "cwd", cwd },
      context,
    )) as string;
  }
  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (request.env !== undefined || request.pty)
      throw new Error("Host environment and terminal overrides are not allowed.");
    for await (const frame of this.client.request(
      {
        op: "computer.exec",
        homeKey: computer.botId,
        argv: request.argv,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
      },
      context,
    )) {
      if (frame.channel === "stdout" || frame.channel === "stderr")
        yield { type: frame.channel, data: String(frame.data) };
      else if (frame.channel === "exit") yield { type: "exit", code: Number(frame.data) };
    }
  }
  override async listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return (await this.client.result(
      { op: "computer.files.list", homeKey: computer.botId, path: path || "." },
      context,
    )) as ComputerFileEntry[];
  }
  override async readFile(
    computer: ComputerRef,
    path: string,
    context?: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    if (!context) throw new Error("An active run is required.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const frame of this.client.request(
      {
        op: "computer.files.read",
        homeKey: computer.botId,
        path,
        maxBytes: Math.min(options?.maxBytes ?? HOST_FILE_BYTES, HOST_FILE_BYTES),
      },
      context,
    )) {
      if (frame.channel !== "file" || typeof frame.data !== "string")
        throw new Error("Unexpected host file frame.");
      const chunk = Buffer.from(frame.data, "base64");
      size += chunk.length;
      if (size > HOST_FILE_BYTES) throw new Error("Host file too large.");
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  override async writeFile(computer: ComputerRef, file: PortableFile, context?: AdapterContext) {
    if (!context || file.content.length > HOST_FILE_BYTES)
      throw new Error("An active run and bounded file are required.");
    await this.client.result(
      {
        op: "computer.files.write",
        homeKey: computer.botId,
        path: file.path,
        content: Buffer.from(file.content).toString("base64"),
        executable: file.executable,
      },
      context,
    );
  }
  // Host workspaces already persist on the host. Never copy them into the container's home store.
  override async *exportWorkspace(
    computer: ComputerRef,
    context?: AdapterContext,
  ): AsyncIterable<PortableFile> {
    if (!context) throw new Error("An authorized operation is required.");
    for await (const frame of this.client.request(
      { op: "computer.files.export", homeKey: computer.botId },
      context,
    )) {
      if (frame.channel !== "file") continue;
      const file = frame.data as { path: string; content: string; executable?: boolean };
      yield { ...file, content: Buffer.from(file.content, "base64") };
    }
  }
  override async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) await this.writeFile(computer, file, context);
  }
  override async snapshot(computer: ComputerRef, context: AdapterContext) {
    return (await this.lifecycle(computer, "snapshot", context)) as {
      id: string;
      createdAt: string;
    };
  }
  override async stop(computer: ComputerRef, context: AdapterContext) {
    if (context.runId) await this.lifecycle(computer, "sleep", context);
  }
  override async destroy(computer: ComputerRef, context: AdapterContext) {
    if (context.runId) await this.lifecycle(computer, "destroy", context);
  }
}
