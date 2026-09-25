import { StringDecoder } from "node:string_decoder";
import type {
  AdapterContext,
  CommandRequest,
  ComputerFileEntry,
  ComputerRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import { DELEGATION_WORKSPACE_SCRIPT, teamBotWorkspaceDirectory } from "@ardurbot/adapters";
import { unknownCapacity } from "@ardurbot/contracts/fleet";
import type { TaskContract } from "../../scoreboard/tasks/catalog.js";
import { requireValue } from "../budget.js";
import type { TrialAdmission } from "./admission.js";
import type { ContainerSession } from "./session.js";

/** A real cached-image computer. Every file and command executes in the same bounded tmpfs/cgroup. */
export class ContainerComputer implements SandboxProvider {
  private ref: ComputerRef | null = null;
  constructor(
    readonly session: ContainerSession,
    private readonly task: TaskContract,
    readonly admission: TrialAdmission,
  ) {}
  describe() {
    return {
      id: "versus-container",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: {
        graphical: false,
        pty: false,
        snapshots: false,
        takeover: false,
        persistentHome: false,
      },
    };
  }
  async capacity() {
    return unknownCapacity();
  }
  async supportsNetworkEgress() {
    return false;
  }
  private check(computer: ComputerRef) {
    requireValue(
      this.ref && computer.id === this.ref.id && computer.providerRef === this.session.id,
      "Computer outside owned trial",
    );
  }
  private name(file: string) {
    const relative = file
      .replace(/^\/home\/ardurbot(?:\/|$)/, "")
      .replace(/^\/opt\/data\/workspace(?:\/|$)/, "");
    requireValue(
      !relative.startsWith("/") && !relative.split("/").includes("..") && !relative.includes("\0"),
      "Computer path outside trial",
    );
    return `workspace/${relative}`;
  }
  async provision(
    request: { botId: string; homePath: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    await this.session.assertReady();
    if (this.ref) return { ...this.ref, fresh: false };
    this.ref = {
      id: this.session.id,
      botId: request.botId,
      kind: "docker",
      providerRef: this.session.id,
      networkEgress: false,
      fresh: true,
    };
    requireValue(context.botId, "Missing trial bot identity");
    for (const [name, content] of Object.entries(this.task.files))
      await this.session.write(
        this.name(`${teamBotWorkspaceDirectory(context.botId)}/${name}`),
        content,
      );
    return this.ref;
  }
  async prepare(computer: ComputerRef) {
    this.check(computer);
    await this.session.assertReady();
  }
  async resolveCommandCwd(computer: ComputerRef, cwd: string | undefined) {
    this.check(computer);
    return `/opt/data/${this.name(cwd ?? "")}`;
  }
  async environmentNote() {
    return "Linux container; read-only root, bounded trial tmpfs, gateway-only relay; unadmitted forks denied.";
  }
  async writeFile(computer: ComputerRef, file: PortableFile, _context: AdapterContext) {
    this.check(computer);
    await this.session.write(this.name(file.path), file.content);
  }
  async readFile(
    computer: ComputerRef,
    file: string,
    _context: AdapterContext,
    options?: { maxBytes?: number; preview?: boolean },
  ) {
    this.check(computer);
    const content = await this.session.read(this.name(file));
    if (options?.maxBytes !== undefined && content.length > options.maxBytes && !options.preview)
      throw new Error("File size limit");
    return new Uint8Array(options?.preview ? content.subarray(0, options.maxBytes) : content);
  }
  async listFiles(
    computer: ComputerRef,
    directory: string,
    _context?: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    this.check(computer);
    const root = this.name(directory).replace(/\/+$/, "");
    const relative = root.replace(/^workspace\/?/, "");
    const value = await this.session.file("list", root);
    requireValue(Array.isArray(value), "Container listing unavailable");
    const entries: ComputerFileEntry[] = [];
    for (const item of value) {
      requireValue(item && typeof item === "object", "Container listing unavailable");
      const record = item as Record<string, unknown>;
      const name = record.name;
      requireValue(
        typeof name === "string" &&
          name.length > 0 &&
          name !== "." &&
          name !== ".." &&
          !name.includes("/") &&
          !name.includes("\0"),
        "Container listing unavailable",
      );
      requireValue(
        record.kind === "file" || record.kind === "dir",
        "Container listing unavailable",
      );
      requireValue(
        typeof record.size === "number" && record.size >= 0,
        "Container listing unavailable",
      );
      entries.push({
        path: relative ? `${relative}/${name}` : name,
        kind: record.kind,
        size: record.kind === "dir" ? 0 : record.size,
        ...(record.kind === "file" && record.executable === true ? { executable: true } : {}),
      });
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }
  async *exportWorkspace(computer: ComputerRef): AsyncIterable<PortableFile> {
    this.check(computer);
    for (const [file, content] of Object.entries(await this.session.snapshot()))
      yield { path: file, content: Buffer.from(content) };
  }
  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) await this.writeFile(computer, file, context);
  }
  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    this.check(computer);
    context.signal.throwIfAborted();
    if (!this.admission.current()) {
      requireValue(
        context.botId &&
          JSON.stringify(request.argv) ===
            JSON.stringify(["mkdir", "-p", "shared", teamBotWorkspaceDirectory(context.botId)]),
        "Unadmitted computer command",
      );
      for (const name of request.argv.slice(2)) await this.session.file("mkdir", this.name(name));
      yield { type: "exit", code: 0 };
      return;
    }
    if (this.admission.current()?.name === "workspace-prepare") {
      yield* this.prepareWorkspace(request);
      return;
    }
    this.admission.requireEffect("shell");
    this.admission.descendant("computer-command");
    requireValue(
      !request.pty && !request.hostIntegration && !Object.keys(request.env ?? {}).length,
      "Unqualified command environment or PTY",
    );
    const argv = request.argv.map((arg, index) =>
      index === 0 && !arg.startsWith("/") ? `/usr/bin/${arg}` : arg,
    );
    // The production launcher's login shell sources /etc/profile, which forks. This lane denies fork.
    const confined = argv.map((arg, index) =>
      index === 2 ? arg.replaceAll('exec bash -lc "$4"', 'exec bash --noprofile -lc "$4"') : arg,
    );
    yield* this.runProduct(confined, request, context);
  }
  private async *prepareWorkspace(request: CommandRequest): AsyncIterable<ProcessEvent> {
    const directory = request.argv[5];
    requireValue(
      request.argv.length === 6 &&
        (request.argv[0] === "bash" || request.argv[0] === "/usr/bin/bash") &&
        request.argv[1] === "-c" &&
        request.argv[2] === DELEGATION_WORKSPACE_SCRIPT &&
        request.argv[3] === "task-workspace" &&
        typeof request.argv[4] === "string" &&
        !request.argv[4].includes("\0") &&
        typeof directory === "string" &&
        /^tasks\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(directory),
      "Unadmitted computer command",
    );
    await this.session.file("mkdir", this.name(directory));
    yield { type: "stdout", data: "artifacts" };
    yield { type: "exit", code: 0 };
  }
  private async *runProduct(
    argv: string[],
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    let stdout = "",
      stderr = "";
    let bytes = 0,
      stopped = false;
    const stdoutDecoder = new StringDecoder("utf8"),
      stderrDecoder = new StringDecoder("utf8");
    const abort = () => {
      stopped = true;
      void this.session.destroy();
    };
    if (context.signal.aborted) abort();
    else {
      context.signal.addEventListener("abort", abort, { once: true });
      if (context.signal.aborted) abort();
    }
    const timer = setTimeout(
      abort,
      Math.min(request.timeoutMs ?? this.session.policy.wallMs, this.session.policy.wallMs),
    );
    const cancelled = () =>
      new Error("Container command cancelled or exceeded output/deadline budget");
    try {
      if (stopped || context.signal.aborted) throw cancelled();
      const child = await this.session.exec(argv, {
        cwd: `/opt/data/${this.name(request.cwd ?? "")}`,
        signal: context.signal,
      });
      if (context.signal.aborted) abort();
      child.stdout!.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > 2 * 1024 * 1024) abort();
        if (!stopped) stdout += stdoutDecoder.write(data);
      });
      child.stderr!.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > 2 * 1024 * 1024) abort();
        if (!stopped) stderr += stderrDecoder.write(data);
      });
      const code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode) => resolve(exitCode ?? 1));
      });
      if (stopped || context.signal.aborted) throw cancelled();
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (stdout) yield { type: "stdout", data: stdout };
      if (stderr) yield { type: "stderr", data: stderr };
      yield { type: "exit", code };
    } catch (error) {
      if (stopped || context.signal.aborted) throw cancelled();
      throw error;
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
    }
  }
  async snapshotFiles(_homeKey: string, botId: string) {
    return this.session.snapshot(this.name(teamBotWorkspaceDirectory(botId)));
  }
  async connectScreen(): Promise<never> {
    throw new Error("Graphical computer unsupported in controlled container lane");
  }
  async sendInput(): Promise<never> {
    throw new Error("Graphical computer unsupported in controlled container lane");
  }
  async observe(): Promise<never> {
    throw new Error("Graphical computer unsupported in controlled container lane");
  }
  async act(): Promise<never> {
    throw new Error("Graphical computer unsupported in controlled container lane");
  }
  async snapshot(): Promise<never> {
    throw new Error("Persistent snapshots unsupported in disposable lane");
  }
  async stop(computer: ComputerRef) {
    this.check(computer);
    await this.session.destroy();
  }
  async destroy(computer: ComputerRef) {
    this.check(computer);
    await this.session.destroy();
  }
}
