import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  ComputerRef,
  PortableFile,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import type { SshSettings } from "@ardurbot/contracts";
import { SshSettingsSchema } from "@ardurbot/contracts/fleet";
import { fleetPath } from "./archive.js";
import { cachedCapacity, LINUX_CAPACITY_COMMAND, parseLinuxCapacity } from "./capacity.js";
import { FLEET_LINUX_CAPABILITIES, fleetComputerKey, LinuxFleetSandbox } from "./linux-sandbox.js";
import { LINUX_FILE_SCRIPT, LINUX_ROOT, SSH_HOME_SCRIPT } from "./linux-scripts.js";
import type { FleetProcess } from "./process.js";
import { remoteArgv, systemFleetProcess } from "./process.js";

export function sshOptions(settings: SshSettings, identityFile?: string) {
  const validated = SshSettingsSchema.parse(settings);
  if (validated.authentication === "private-key" && !identityFile)
    throw new Error("Choose an SSH key in Settings.");
  return [
    "-F",
    "none",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "RequestTTY=no",
    ...(validated.jumpHost ? ["-J", validated.jumpHost] : []),
    ...(identityFile
      ? ["-i", identityFile, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none"]
      : validated.authentication === "tailscale"
        ? ["-o", "IdentityAgent=none", "-o", "IdentityFile=none"]
        : ["-o", "IdentityFile=none"]),
  ];
}
export class SshSandboxProvider extends LinuxFleetSandbox {
  readonly settings: SshSettings;
  private homes = new Map<string, { root: string; fresh: boolean }>();
  constructor(
    settings: SshSettings,
    private readonly processes: FleetProcess = systemFleetProcess,
    private readonly privateKey?: () => Promise<string>,
  ) {
    super();
    this.settings = SshSettingsSchema.parse(settings);
  }
  describe() {
    return {
      id: "ssh",
      kind: "ssh" as const,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: FLEET_LINUX_CAPABILITIES,
    };
  }
  private async identity() {
    if (this.settings.authentication !== "private-key")
      return { options: sshOptions(this.settings), cleanup: async () => undefined };
    if (!this.privateKey) throw new Error("SSH key is unavailable.");
    const directory = await mkdtemp(path.join(tmpdir(), "ardurbot-key-"));
    const file = path.join(directory, "identity");
    try {
      await writeFile(file, await this.privateKey(), { mode: 0o600 });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return {
      options: sshOptions(this.settings, file),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  }
  private destination() {
    return `${this.settings.user}@${this.settings.host.includes(":") ? `[${this.settings.host}]` : this.settings.host}`;
  }
  private async raw(argv: string[], context: AdapterContext, input?: Uint8Array, limit?: number) {
    const identity = await this.identity();
    try {
      const result = await this.processes.run(
        "ssh",
        [
          ...identity.options,
          "-p",
          String(this.settings.port),
          "--",
          this.destination(),
          remoteArgv(argv),
        ],
        AbortSignal.any([context.signal, AbortSignal.timeout(300_000)]),
        input,
        limit,
      );
      if (result.code !== 0)
        throw new Error("SSH operation failed; test the connection in Computers.");
      return result.stdout;
    } finally {
      await identity.cleanup();
    }
  }
  async provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    if (request.networkEgress === false)
      throw new Error("Network isolation is not available on SSH computers.");
    const key = fleetComputerKey(context.spaceId, request.botId);
    const home = JSON.parse(
      (
        await this.raw(
          ["python3", "-c", SSH_HOME_SCRIPT, this.settings.baseDirectory, key],
          context,
        )
      ).toString(),
    ) as { root: string; fresh: boolean };
    if (!home.root.startsWith("/") || !home.root.endsWith(`/${key}`) || home.root.includes("\n"))
      throw new Error("Invalid remote computer home.");
    this.homes.set(key, home);
    return {
      id: `ssh:${key}`,
      providerRef: `ssh:${key}`,
      kind: "ssh",
      botId: request.botId,
      connectionId: request.connectionId,
      imageProfile: request.imageProfile,
      fresh: home.fresh,
    };
  }
  async root(computer: ComputerRef, context: AdapterContext) {
    const key = fleetComputerKey(context.spaceId, computer.botId);
    if (computer.providerRef !== `ssh:${key}`)
      throw new Error("Computer does not belong to this workspace.");
    if (!this.homes.has(key))
      await this.provision({ botId: computer.botId, homePath: "" }, context);
    return this.homes.get(key)!.root;
  }
  async call(
    computer: ComputerRef,
    argv: string[],
    context: AdapterContext,
    input?: Uint8Array,
    limit?: number,
  ) {
    await this.root(computer, context);
    return this.raw(argv, context, input, limit);
  }
  async start(computer: ComputerRef, argv: string[], context: AdapterContext) {
    await this.root(computer, context);
    const identity = await this.identity();
    try {
      return {
        child: await this.processes.start("ssh", [
          ...identity.options,
          "-p",
          String(this.settings.port),
          "--",
          this.destination(),
          remoteArgv(argv),
        ]),
        cleanup: identity.cleanup,
      };
    } catch (error) {
      await identity.cleanup();
      throw error;
    }
  }
  readonly capacity = cachedCapacity(async () => {
    const context: AdapterContext = {
      operationId: "capacity",
      traceId: "capacity",
      userId: "capacity",
      spaceId: "capacity",
      signal: AbortSignal.timeout(8000),
    };
    return parseLinuxCapacity(
      (await this.raw(LINUX_CAPACITY_COMMAND, context, undefined, 128 * 1024)).toString(),
    );
  });
  private async sftp(
    computer: ComputerRef,
    content: Uint8Array | undefined,
    relative: string,
    context: AdapterContext,
    maxBytes: number,
    executable = false,
    preview = false,
  ) {
    fleetPath(relative);
    const root = await this.root(computer, context);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 16 * 1024 * 1024)
      throw new Error("Invalid file size limit.");
    const local = await mkdtemp(path.join(tmpdir(), "ardurbot-transfer-"));
    let identity: Awaited<ReturnType<SshSandboxProvider["identity"]>> | undefined;
    let stage: string | undefined;
    try {
      identity = await this.identity();
      const created = (
        await this.raw(
          [
            "python3",
            "-c",
            "import tempfile; print(tempfile.mkdtemp(prefix='ardurbot-transfer-',dir='/tmp'))",
          ],
          context,
        )
      )
        .toString()
        .trim();
      if (!/^\/tmp\/ardurbot-transfer-[a-zA-Z0-9_-]+$/.test(created))
        throw new Error("Invalid transfer directory.");
      stage = created;
      const file = path.join(local, "content");
      const escaped = (value: string) => JSON.stringify(value);
      if (content) await writeFile(file, content, { mode: 0o600 });
      else
        await this.raw(
          [
            "python3",
            "-c",
            LINUX_FILE_SCRIPT,
            root,
            preview ? "stage-preview" : "stage-read",
            relative,
            String(maxBytes),
            "false",
            `${stage}/content`,
          ],
          context,
        );
      const command = content
        ? `put ${escaped(file)} ${escaped(`${stage}/content`)}\n`
        : `get ${escaped(`${stage}/content`)} ${escaped(file)}\n`;
      const result = await this.processes.run(
        "sftp",
        [
          ...identity.options,
          "-P",
          String(this.settings.port),
          "-b",
          "-",
          "--",
          this.destination(),
        ],
        AbortSignal.any([context.signal, AbortSignal.timeout(60_000)]),
        Buffer.from(command),
        65536,
      );
      if (result.code !== 0)
        throw new Error("File transfer failed; test the connection in Computers.");
      if (content) {
        await this.raw(
          [
            "python3",
            "-c",
            LINUX_FILE_SCRIPT,
            root,
            "stage-write",
            relative,
            String(maxBytes),
            String(executable),
            `${stage}/content`,
          ],
          context,
        );
        return new Uint8Array();
      }
      const bytes = await readFile(file);
      if (bytes.length > maxBytes) throw new Error("File exceeds limit.");
      return new Uint8Array(bytes);
    } finally {
      if (stage)
        await this.raw(["python3", "-c", "import shutil,sys; shutil.rmtree(sys.argv[1])", stage], {
          ...context,
          signal: AbortSignal.timeout(5000),
        }).catch(() => undefined);
      await identity?.cleanup();
      await rm(local, { recursive: true, force: true });
    }
  }

  override readFile(
    computer: ComputerRef,
    relative: string,
    context: AdapterContext,
    options?: { maxBytes?: number; preview?: boolean },
  ) {
    return this.sftp(
      computer,
      undefined,
      relative,
      context,
      Math.min(options?.maxBytes ?? 16 * 1024 * 1024, 16 * 1024 * 1024),
      false,
      options?.preview,
    );
  }
  override async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    if (file.content.length > 16 * 1024 * 1024) throw new Error("File exceeds limit.");
    await this.sftp(computer, file.content, file.path, context, 16 * 1024 * 1024, file.executable);
  }
  async test(context: AdapterContext) {
    const result = await this.raw(
      [
        "python3",
        "-c",
        "import platform,shutil; assert platform.system()=='Linux' and shutil.which('bash'); print(platform.release())",
      ],
      { ...context, signal: AbortSignal.any([context.signal, AbortSignal.timeout(10000)]) },
    );
    return { os: "Linux", version: result.toString().trim(), capacity: await this.capacity() };
  }
  async destroy(computer: ComputerRef, context: AdapterContext) {
    await this.stop(computer, context);
    await this.call(
      computer,
      [
        "python3",
        "-c",
        `${LINUX_ROOT}\nfor name in os.listdir(fd):\n info=os.stat(name,dir_fd=fd,follow_symlinks=False)\n if stat.S_ISDIR(info.st_mode): shutil.rmtree(name,dir_fd=fd)\n else: os.unlink(name,dir_fd=fd)\nos.close(fd); os.rmdir(root)`,
        await this.root(computer, context),
      ],
      context,
    );
    this.homes.delete(fleetComputerKey(context.spaceId, computer.botId));
  }
}
