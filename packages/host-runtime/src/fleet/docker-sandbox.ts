import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@ardurbot/adapter-kit";
import type {
  CapacitySnapshot,
  ComputerConnectionSettings,
  SshSettings,
} from "@ardurbot/contracts";
import { ComputerConnectionSettingsSchema, ComputerWorkspaceSaveError } from "@ardurbot/contracts";
import { COMPUTER_IMAGE_PINS } from "@ardurbot/contracts/computer-image";
import { SshSettingsSchema } from "@ardurbot/contracts/fleet";
import {
  cachedCapacity,
  dockerCapacity,
  hostCapacity,
  LINUX_CAPACITY_COMMAND,
  normalizeEngineInfo,
  parseLinuxCapacity,
} from "./capacity.js";
import { connectionComputerImage } from "./computer-image.js";
import { FLEET_LINUX_CAPABILITIES, fleetComputerKey, LinuxFleetSandbox } from "./linux-sandbox.js";
import { engineFailureReason } from "./probe.js";
import type { FleetProcess } from "./process.js";
import { remoteArgv, systemFleetProcess } from "./process.js";
import { sshOptions } from "./ssh-sandbox.js";

class EngineCommandError extends Error {
  constructor(
    readonly category: string,
    message: string,
  ) {
    super(message);
  }
}

function saveEngineError(error: unknown): ComputerWorkspaceSaveError {
  if (error instanceof ComputerWorkspaceSaveError) return error;
  const category =
    error instanceof EngineCommandError ? error.category : engineFailureReason(error);
  if (
    category === "source-not-running" ||
    category === "source-missing" ||
    category === "too-large"
  )
    return new ComputerWorkspaceSaveError(category, category);
  return new ComputerWorkspaceSaveError(
    category && category !== "command-failed" ? "engine-unreachable" : "save-failed",
    category ?? "command-failed",
  );
}

/** Convert the shared Kubernetes-style quantities to Docker CLI resource values. */
export function engineLimits(settings: ComputerConnectionSettings) {
  const cpu = /^(\d+(?:\.\d+)?)(m)?$/.exec(settings.cpuLimit);
  const memory = /^(\d+(?:\.\d+)?)([KMGT])?(i)?$/.exec(settings.memoryLimit);
  if (!cpu || !memory) throw new Error("Invalid engine resource limits.");
  const cpus = Number(cpu[1]) / (cpu[2] ? 1000 : 1);
  const power = memory[2] ? "KMGT".indexOf(memory[2]) + 1 : 0;
  const bytes = Number(memory[1]) * (memory[3] ? 1024 : 1000) ** power;
  if (!Number.isFinite(cpus) || cpus <= 0 || !Number.isSafeInteger(bytes) || bytes < 6 * 1024 ** 2)
    throw new Error("Invalid engine resource limits.");
  return ["--cpus", String(cpus), "--memory", String(bytes)];
}

export type EngineCredentials = { ca: string; cert: string; key: string };
export function engineCommand(settings: ComputerConnectionSettings, certificateDirectory?: string) {
  const address = settings.endpoint ?? settings.socket;
  const endpoint = address?.startsWith("/") ? `unix://${address}` : address;
  if (endpoint?.startsWith("ssh://")) {
    const url = new URL(endpoint);
    const ssh: SshSettings = SshSettingsSchema.parse({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || 22),
      user: decodeURIComponent(url.username) || userInfo().username,
    });
    return {
      name: "ssh",
      prefix: [...sshOptions(ssh), "-p", String(ssh.port), "--", `${ssh.user}@${url.hostname}`],
      remote: true,
    };
  }
  if (endpoint?.startsWith("tcp://") && !certificateDirectory)
    throw new Error("Choose client TLS certificates in Computers.");
  const podman = settings.engine === "podman";
  return {
    name: podman ? "podman" : "docker",
    prefix: [
      ...(endpoint
        ? [podman ? "--url" : "--host", endpoint]
        : settings.dockerContext
          ? ["--context", settings.dockerContext]
          : []),
      ...(certificateDirectory
        ? [
            ...(podman ? [] : ["--tlsverify"]),
            podman ? "--tls-ca" : "--tlscacert",
            path.join(certificateDirectory, "ca"),
            podman ? "--tls-cert" : "--tlscert",
            path.join(certificateDirectory, "cert"),
            podman ? "--tls-key" : "--tlskey",
            path.join(certificateDirectory, "key"),
          ]
        : []),
    ],
    remote: false,
  };
}

/** The host CLI uses the selected engine's own volume; no worker or host folder is mounted remotely. */
export class FleetDockerSandboxProvider extends LinuxFleetSandbox {
  readonly settings: ComputerConnectionSettings;
  constructor(
    settings: ComputerConnectionSettings,
    private readonly processes: FleetProcess = systemFleetProcess,
    private readonly credentials?: () => Promise<EngineCredentials>,
  ) {
    super();
    this.settings = ComputerConnectionSettingsSchema.parse(settings);
  }
  describe() {
    return {
      id: "remote-docker",
      kind: "remote-docker" as const,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: FLEET_LINUX_CAPABILITIES,
    };
  }
  private async command(argv: string[]) {
    let directory: string | undefined;
    const secrets: string[] = [];
    try {
      if (this.settings.endpoint?.startsWith("tcp://")) {
        if (!this.credentials) throw new Error("TLS certificates are unavailable.");
        const credentials = await this.credentials();
        secrets.push(credentials.ca, credentials.cert, credentials.key);
        directory = await mkdtemp(path.join(tmpdir(), "ardurbot-tls-"));
        for (const name of ["ca", "cert", "key"] as const)
          await writeFile(path.join(directory, name), credentials[name], { mode: 0o600 });
      }
      const command = engineCommand(this.settings, directory);
      return {
        name: command.name,
        secrets,
        argv: [
          ...command.prefix,
          ...(command.remote
            ? [remoteArgv([this.settings.engine === "podman" ? "podman" : "docker", ...argv])]
            : argv),
        ],
        cleanup: async () => {
          if (directory) await rm(directory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  private async engine(
    argv: string[],
    context: AdapterContext,
    input?: Uint8Array,
    limit?: number,
  ) {
    const command = await this.command(argv);
    try {
      const result = await this.processes.run(
        command.name,
        command.argv,
        AbortSignal.any([context.signal, AbortSignal.timeout(300_000)]),
        input,
        limit,
      );
      if (result.code !== 0) {
        const reason = engineFailureReason(result.stderr.toString());
        const stderr = result.stderr.toString();
        const category = /no such container|no such volume/i.test(stderr)
          ? "source-missing"
          : /container .*not running|container .*stopped/i.test(stderr)
            ? "source-not-running"
            : /exceeds.*limit|too large/i.test(stderr)
              ? "too-large"
              : (reason ?? "command-failed");
        throw new EngineCommandError(
          category,
          reason ?? (argv[0] === "info" ? "engine-not-running" : "Engine command failed."),
        );
      }
      return result.stdout;
    } finally {
      await command.cleanup();
    }
  }
  private name(computer: ComputerRef, context: AdapterContext) {
    const name = `ardurbot-${fleetComputerKey(context.spaceId, computer.botId).slice(0, 40)}`;
    if (computer.providerRef !== name)
      throw new Error("Computer does not belong to this workspace.");
    return name;
  }
  private async owned(name: string, context: AdapterContext) {
    const listing = (
      await this.engine(
        [
          "container",
          "ls",
          "--all",
          "--filter",
          `label=ardurbot.com/computer=${name}`,
          "--format",
          "{{.ID}}",
        ],
        context,
      )
    )
      .toString()
      .trim();
    if (!listing) return null;
    const details = JSON.parse(
      (await this.engine(["inspect", "--type", "container", name], context)).toString(),
    ) as {
      Config: { Image: string; Labels?: Record<string, string> };
      State?: { Running?: boolean };
      HostConfig?: { NetworkMode?: string };
    }[];
    const record = details[0];
    if (
      record?.Config.Labels?.["ardurbot.com/computer"] !== name ||
      record.Config.Labels?.["ardurbot.com/space"] !== context.spaceId
    )
      throw new Error("Engine computer identity does not match.");
    return record;
  }
  private async ownedVolume(name: string, context: AdapterContext) {
    const volume = `${name}-home`;
    const listed = (
      await this.engine(
        ["volume", "ls", "--filter", `name=^${volume}$`, "--format", "{{.Name}}"],
        context,
      )
    )
      .toString()
      .trim();
    if (!listed) return false;
    const records = JSON.parse(
      (await this.engine(["volume", "inspect", volume], context)).toString(),
    ) as { Labels?: Record<string, string> }[];
    if (
      records[0]?.Labels?.["ardurbot.com/computer"] !== name ||
      records[0]?.Labels?.["ardurbot.com/space"] !== context.spaceId
    )
      throw new Error("Engine volume identity does not match.");
    return true;
  }
  async provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const name = `ardurbot-${fleetComputerKey(context.spaceId, request.botId).slice(0, 40)}`;
    const profile = request.imageProfile ?? "base";
    const image = connectionComputerImage(profile, this.settings);
    // Never pull, build, or substitute an image during placement.
    await this.engine(["image", "inspect", image], context).catch((error: unknown) => {
      if (error instanceof Error && error.message === "Engine command failed.")
        throw new Error(`Pull ${image} into this engine, then try again.`);
      throw error;
    });
    let existing = await this.owned(name, context);
    const networkEgress = request.networkEgress ?? true;
    if (existing && (existing.HostConfig?.NetworkMode !== "none") !== networkEgress)
      throw new Error("The computer network differs from its saved setting; confirm an update.");
    if (existing && existing.Config.Image !== image) {
      const legacyTag = COMPUTER_IMAGE_PINS[profile].tag;
      const defaultImage = connectionComputerImage(profile, {});
      if (existing.Config.Image === legacyTag && image === defaultImage) {
        await this.engine(["rm", "-f", name], context);
        existing = null;
      } else {
        throw new Error(
          "The computer image differs from its saved profile; confirm an update in Computers.",
        );
      }
    }
    if (!existing) {
      if (!(await this.ownedVolume(name, context)))
        await this.engine(
          [
            "volume",
            "create",
            "--label",
            `ardurbot.com/computer=${name}`,
            "--label",
            `ardurbot.com/space=${context.spaceId}`,
            `${name}-home`,
          ],
          context,
        );
      await this.engine(
        [
          "create",
          "--name",
          name,
          "--label",
          `ardurbot.com/computer=${name}`,
          "--label",
          `ardurbot.com/space=${context.spaceId}`,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "1000:1000",
          ...engineLimits(this.settings),
          ...(!networkEgress ? ["--network", "none"] : []),
          "--mount",
          `type=volume,src=${name}-home,dst=/home/ardurbot`,
          "--workdir",
          "/home/ardurbot",
          image,
          "sleep",
          "infinity",
        ],
        context,
      );
    }
    if (!existing?.State?.Running) await this.engine(["start", name], context);
    return {
      id: name,
      providerRef: name,
      kind: "remote-docker",
      botId: request.botId,
      connectionId: request.connectionId,
      imageProfile: request.imageProfile,
      networkEgress,
      fresh: !existing,
    };
  }
  async root(computer: ComputerRef, context: AdapterContext) {
    this.name(computer, context);
    return "/home/ardurbot";
  }
  async ensureWorkspaceReady(computer: ComputerRef, context: AdapterContext) {
    try {
      const name = this.name(computer, context);
      const existing = await this.owned(name, context);
      if (!existing || !(await this.ownedVolume(name, context)))
        throw new ComputerWorkspaceSaveError("source-missing");
      if (!existing.State?.Running) await this.engine(["start", name], context);
      if (!(await this.owned(name, context))?.State?.Running)
        throw new ComputerWorkspaceSaveError("source-not-running");
    } catch (error) {
      throw saveEngineError(error);
    }
  }
  override async *exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    try {
      yield* super.exportWorkspace(computer, context);
    } catch (error) {
      throw saveEngineError(error);
    }
  }
  async supportsNetworkEgress() {
    return true;
  }
  async call(
    computer: ComputerRef,
    argv: string[],
    context: AdapterContext,
    input?: Uint8Array,
    limit?: number,
  ) {
    const name = this.name(computer, context);
    await this.owned(name, context);
    return this.engine(["exec", "-i", name, ...argv], context, input, limit);
  }
  async start(computer: ComputerRef, argv: string[], context: AdapterContext) {
    const name = this.name(computer, context);
    await this.owned(name, context);
    const command = await this.command(["exec", "-i", name, ...argv]);
    try {
      return {
        child: await this.processes.start(command.name, command.argv),
        cleanup: command.cleanup,
        secrets: command.secrets,
      };
    } catch (error) {
      await command.cleanup();
      throw error;
    }
  }
  async test(context: AdapterContext) {
    const raw = JSON.parse(
      (
        await this.engine(["info", "--format", "{{json .}}"], context, undefined, 512 * 1024)
      ).toString(),
    ) as Record<string, unknown>;
    const info = normalizeEngineInfo(raw);
    const version = String(info.ServerVersion ?? "");
    const os = String(info.OperatingSystem ?? info.OSType ?? "");
    if (info.OSType !== "linux") throw new Error("Choose a Linux container engine.");
    let measured: CapacitySnapshot | undefined;
    if (this.settings.endpoint?.startsWith("ssh://")) {
      const command = engineCommand(this.settings);
      const result = await this.processes.run(
        command.name,
        [...command.prefix, remoteArgv(LINUX_CAPACITY_COMMAND)],
        context.signal,
        undefined,
        128 * 1024,
      );
      if (result.code === 0) measured = parseLinuxCapacity(result.stdout.toString());
    } else if (!this.settings.endpoint?.startsWith("tcp://")) {
      measured = await hostCapacity();
    }
    const capacity = dockerCapacity(raw, measured);
    if (capacity.memoryFree !== null && capacity.memoryTotal !== null)
      capacity.memoryFree = Math.min(capacity.memoryFree, capacity.memoryTotal);
    return {
      version,
      os,
      capacity,
      name: this.settings.engine,
      rootless: JSON.stringify(info.SecurityOptions ?? []).includes("rootless"),
    };
  }
  readonly capacity = cachedCapacity(async () => {
    const context: AdapterContext = {
      operationId: "capacity",
      traceId: "capacity",
      userId: "capacity",
      spaceId: "capacity",
      signal: AbortSignal.timeout(8000),
    };
    const info = JSON.parse(
      (
        await this.engine(["info", "--format", "{{json .}}"], context, undefined, 512 * 1024)
      ).toString(),
    ) as Record<string, unknown>;
    if (this.settings.endpoint?.startsWith("ssh://")) {
      const command = engineCommand(this.settings);
      const result = await this.processes.run(
        command.name,
        [...command.prefix, remoteArgv(LINUX_CAPACITY_COMMAND)],
        context.signal,
        undefined,
        128 * 1024,
      );
      return dockerCapacity(
        info,
        result.code === 0 ? parseLinuxCapacity(result.stdout.toString()) : undefined,
      );
    }
    if (
      this.settings.endpoint?.startsWith("tcp://") ||
      (this.settings.dockerContext && !this.settings.endpoint)
    )
      return dockerCapacity(info);
    const host = await hostCapacity();
    const capacity = dockerCapacity(info, host);
    if (capacity.memoryFree !== null && capacity.memoryTotal !== null)
      capacity.memoryFree = Math.min(capacity.memoryFree, capacity.memoryTotal);
    return capacity;
  });
  override async stop(computer: ComputerRef, context: AdapterContext) {
    await this.terminal.revoke(computer, "*", context);
    const name = this.name(computer, context);
    if (await this.owned(name, context)) await this.engine(["stop", "--time", "5", name], context);
  }
  async destroy(computer: ComputerRef, context: AdapterContext) {
    await this.stop(computer, context);
    const name = this.name(computer, context);
    if (await this.owned(name, context)) await this.engine(["rm", name], context);
    if (await this.ownedVolume(name, context))
      await this.engine(["volume", "rm", `${name}-home`], context);
  }
}
