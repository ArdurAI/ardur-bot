import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import type {
  AdapterContext,
  CommandRequest,
  ComputerFileEntry,
  ComputerObservation,
  ComputerRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import type { CapacitySnapshot } from "@ardurbot/contracts";
import { boundedSandboxCommandTimeoutMs } from "@ardurbot/core";
import { fleetPath, MAX_FLEET_ARCHIVE, readFleetArchive, writeFleetArchive } from "./archive.js";
import {
  LINUX_ARCHIVE_SCRIPT,
  LINUX_EXEC_SCRIPT,
  LINUX_FILE_SCRIPT,
  LINUX_RESTORE_SCRIPT,
  LINUX_STOP_SCRIPT,
} from "./linux-scripts.js";
import { streamFleetProcess } from "./process.js";
import { FleetTerminal } from "./terminal.js";

export function fleetComputerKey(spaceId: string, homeKey: string) {
  return createHash("sha256").update(`${spaceId}\0${homeKey}`).digest("hex");
}
export abstract class LinuxFleetSandbox implements SandboxProvider {
  abstract capacity(context: AdapterContext): Promise<CapacitySnapshot>;
  readonly terminal = new FleetTerminal(
    (computer, argv, context) => this.start(computer, argv, context),
    (computer, context) => this.root(computer, context),
  );
  abstract describe(): ReturnType<SandboxProvider["describe"]>;
  abstract provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef>;
  abstract root(computer: ComputerRef, context: AdapterContext): Promise<string>;
  abstract call(
    computer: ComputerRef,
    argv: string[],
    context: AdapterContext,
    input?: Uint8Array,
    limit?: number,
  ): Promise<Buffer>;
  abstract start(
    computer: ComputerRef,
    argv: string[],
    context: AdapterContext,
  ): Promise<{ child: ChildProcessWithoutNullStreams; cleanup(): Promise<void> }>;
  async prepare(computer: ComputerRef, context: AdapterContext) {
    await this.call(computer, ["python3", "-c", "import os; print(os.name)"], context);
  }
  async resolveCommandCwd(computer: ComputerRef, cwd: string | undefined, context: AdapterContext) {
    const root = await this.root(computer, context);
    const relative = fleetPath(
      cwd === root ? "" : cwd?.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : (cwd ?? ""),
    );
    return relative ? `${root}/${relative}` : root;
  }
  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (!request.argv.length || request.argv.some((value) => value.includes("\0")))
      throw new Error("Invalid command argument.");
    const root = await this.root(computer, context);
    const cwd = await this.resolveCommandCwd(computer, request.cwd, context);
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    const argv = [
      "python3",
      "-c",
      LINUX_EXEC_SCRIPT,
      root,
      JSON.stringify({
        ...request,
        cwd: cwd === root ? "" : cwd.slice(root.length + 1),
        timeoutMs,
      }),
    ];
    const started = await this.start(computer, argv, context);
    try {
      yield* streamFleetProcess(
        started.child,
        AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs + 5000)]),
      );
    } finally {
      await started.cleanup();
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
  async file(
    computer: ComputerRef,
    operation: string,
    relative: string,
    context: AdapterContext,
    input?: Uint8Array,
    maxBytes = 16 * 1024 * 1024,
    executable = false,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 16 * 1024 * 1024)
      throw new Error("Invalid file size limit.");
    return this.call(
      computer,
      [
        "python3",
        "-c",
        LINUX_FILE_SCRIPT,
        await this.root(computer, context),
        operation,
        fleetPath(relative),
        String(maxBytes),
        String(executable),
      ],
      context,
      input,
      maxBytes + 1024 * 1024,
    );
  }
  async listFiles(
    computer: ComputerRef,
    relative: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    return JSON.parse((await this.file(computer, "list", relative, context)).toString());
  }
  async readFile(
    computer: ComputerRef,
    relative: string,
    context: AdapterContext,
    options?: { maxBytes?: number; preview?: boolean },
  ) {
    return new Uint8Array(
      await this.file(
        computer,
        options?.preview ? "preview" : "read",
        relative,
        context,
        undefined,
        options?.maxBytes,
      ),
    );
  }
  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    if (file.content.length > 16 * 1024 * 1024) throw new Error("File exceeds limit.");
    await this.file(
      computer,
      "write",
      file.path,
      context,
      file.content,
      undefined,
      file.executable,
    );
  }
  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const archive = await this.call(
      computer,
      ["python3", "-c", LINUX_ARCHIVE_SCRIPT, await this.root(computer, context)],
      context,
      undefined,
      MAX_FLEET_ARCHIVE,
    );
    yield* readFleetArchive(archive);
  }
  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    await this.call(
      computer,
      ["python3", "-c", LINUX_RESTORE_SCRIPT, await this.root(computer, context)],
      context,
      await writeFleetArchive(files),
    );
  }
  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    return { id: computer.providerRef, createdAt: new Date().toISOString() };
  }
  async stop(computer: ComputerRef, context: AdapterContext) {
    await this.terminal.revoke(computer, "*", context);
    await this.call(
      computer,
      ["python3", "-c", LINUX_STOP_SCRIPT, await this.root(computer, context)],
      context,
    );
  }
  abstract destroy(computer: ComputerRef, context: AdapterContext): Promise<void>;
}

export const FLEET_LINUX_CAPABILITIES = {
  graphical: false,
  pty: true,
  interactiveTerminal: true,
  snapshots: true,
  takeover: false,
  persistentHome: true,
  multiScreen: false,
};
