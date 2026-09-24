import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@ardurbot/adapter-kit";
import type {
  ComputerConnectionSettings,
  HostOperation,
  RemoteComputerCall,
} from "@ardurbot/contracts";
import { HOST_FILE_BYTES } from "@ardurbot/contracts";
import type { EngineCredentials } from "./docker-sandbox.js";
import { FleetDockerSandboxProvider } from "./docker-sandbox.js";
import { HostKubernetesConnection } from "./kubernetes.js";
import { fleetComputerKey, LinuxFleetSandbox } from "./linux-sandbox.js";
import { EncryptedSecretStore } from "./secret-store.js";
import { SshSandboxProvider } from "./ssh-sandbox.js";

export class FleetService {
  private sessions = new Map<
    string,
    {
      provider: SandboxProvider;
      spaceId: string;
      homeKey: string;
      connectionId: string;
      leaseId: string;
      expiresAt: number;
    }
  >();
  private providers = new Map<string, SandboxProvider>();
  private readonly secrets: EncryptedSecretStore;
  constructor(
    private readonly root: string,
    encryptionKey: string,
  ) {
    this.secrets = new EncryptedSecretStore(encryptionKey);
  }
  async importSecret(
    operation: Extract<HostOperation, { op: "computer.remote.secret" }>,
    context: AdapterContext,
  ) {
    const boundedFile = async (file: string) => {
      if (!path.isAbsolute(file) || file.includes("\0"))
        throw new Error("Choose an absolute certificate or key path on this computer.");
      const handle = await open(await realpath(file), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 32768) throw new Error("Key file is invalid.");
        return await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    };
    const value = operation.kubeconfig
      ? { kubeconfig: operation.kubeconfig }
      : operation.privateKeyPath
        ? { privateKey: await boundedFile(operation.privateKeyPath) }
        : operation.tlsPaths
          ? {
              ca: await boundedFile(operation.tlsPaths.ca),
              cert: await boundedFile(operation.tlsPaths.cert),
              key: await boundedFile(operation.tlsPaths.key),
            }
          : null;
    if (!value) throw new Error("Choose a key or TLS certificates.");
    const secret = await this.secrets.put(JSON.stringify(value), context, randomUUID());
    await mkdir(path.join(this.root, "fleet-secrets"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(this.root, "fleet-secrets", secret.id), secret.ciphertext, {
      mode: 0o600,
      flag: "wx",
    });
    return { id: secret.id };
  }
  private async load(
    settings: ComputerConnectionSettings,
  ): Promise<{ privateKey?: string; kubeconfig?: string } & Partial<EngineCredentials>> {
    if (!settings.hostSecretId || !/^[a-f0-9-]{36}$/.test(settings.hostSecretId))
      throw new Error("Computer credentials are unavailable.");
    const ciphertext = await readFile(
      path.join(this.root, "fleet-secrets", settings.hostSecretId),
      "utf8",
    );
    return JSON.parse(this.secrets.load(ciphertext, settings.hostSecretId));
  }
  provider(connectionId: string, settings: ComputerConnectionSettings, spaceId: string) {
    const key = `${spaceId}:${connectionId}:${JSON.stringify(settings)}`;
    let provider = this.providers.get(key);
    if (!provider) {
      if (this.providers.size > 256) throw new Error("Computer connection limit reached.");
      provider =
        settings.engine === "ssh" && settings.ssh
          ? new SshSandboxProvider(settings.ssh, undefined, async () => {
              const key = (await this.load(settings)).privateKey;
              if (!key) throw new Error("SSH key is unavailable.");
              return key;
            })
          : new FleetDockerSandboxProvider(settings, undefined, async () => {
              const value = await this.load(settings);
              if (!value.ca || !value.cert || !value.key)
                throw new Error("TLS certificates are unavailable.");
              return { ca: value.ca, cert: value.cert, key: value.key };
            });
      this.providers.set(key, provider);
    }
    return provider;
  }
  async close() {
    this.sessions.clear();
    await Promise.all(
      [...this.providers.values()].map((provider) =>
        provider instanceof LinuxFleetSandbox ? provider.terminal.closeAll() : undefined,
      ),
    );
  }
  async call(
    operation: RemoteComputerCall,
    context: AdapterContext,
    send: (
      channel: "stdout" | "stderr" | "exit" | "file" | "result",
      data: unknown,
    ) => Promise<void>,
  ) {
    if (operation.settings.engine === "kubernetes") {
      const connection = new HostKubernetesConnection(operation.settings, async () => {
        const value = (await this.load(operation.settings)).kubeconfig;
        if (!value) throw new Error("Kubeconfig is unavailable.");
        return value;
      });
      return connection.call(operation.homeKey, operation.action, context, send);
    }
    const provider = this.provider(operation.connectionId, operation.settings, context.spaceId);
    const action = operation.action;
    for (const [id, session] of this.sessions)
      if (session.expiresAt <= Date.now()) this.sessions.delete(id);
    const hash = fleetComputerKey(context.spaceId, operation.homeKey);
    const reference =
      provider.describe().id === "ssh" ? `ssh:${hash}` : `ardurbot-${hash.slice(0, 40)}`;
    const computer: ComputerRef = {
      id: reference,
      providerRef: reference,
      botId: operation.homeKey,
      kind: provider.describe().id === "ssh" ? "ssh" : "remote-docker",
      connectionId: operation.connectionId,
    };
    if ("sessionId" in action) {
      const session = this.sessions.get(action.sessionId);
      if (
        !session ||
        session.provider !== provider ||
        session.spaceId !== context.spaceId ||
        session.homeKey !== operation.homeKey ||
        session.connectionId !== operation.connectionId ||
        session.leaseId !== action.leaseId
      )
        throw new Error("Terminal lease is unavailable.");
    }
    switch (action.type) {
      case "capacity":
        return send("result", await provider.capacity!(context));
      case "test":
        return send(
          "result",
          provider instanceof FleetDockerSandboxProvider || provider instanceof SshSandboxProvider
            ? await provider.test(context)
            : { capacity: await provider.capacity!(context) },
        );
      case "provision":
        return send(
          "result",
          await provider.provision(
            {
              botId: operation.homeKey,
              homePath: "",
              imageProfile: action.imageProfile,
              connectionId: operation.connectionId,
            },
            context,
          ),
        );
      case "prepare":
        return provider.prepare(computer, context);
      case "sleep":
        return provider.stop(computer, context);
      case "destroy":
        return provider.destroy(computer, context);
      case "snapshot":
        return send("result", await provider.snapshot(computer, context));
      case "cwd":
        return send("result", await provider.resolveCommandCwd!(computer, action.cwd, context));
      case "exec":
        for await (const event of provider.execute(computer, action, context))
          await send(event.type, event.type === "exit" ? event.code : event.data);
        return;
      case "files.list":
        return send("result", await provider.listFiles(computer, action.path, context));
      case "files.read":
        return send(
          "file",
          Buffer.from(
            await provider.readFile(computer, action.path, context, {
              maxBytes: action.maxBytes ?? HOST_FILE_BYTES,
            }),
          ).toString("base64"),
        );
      case "files.write": {
        const bytes = Buffer.from(action.content, "base64");
        if (bytes.length > HOST_FILE_BYTES) throw new Error("Host file exceeds limit.");
        return provider.writeFile(
          computer,
          { path: action.path, content: bytes, executable: action.executable },
          context,
        );
      }
      case "export":
        for await (const file of provider.exportWorkspace(computer, context)) {
          if (file.content.length > HOST_FILE_BYTES)
            throw new Error("Host checkpoint file exceeds limit.");
          await send("file", {
            path: file.path,
            content: Buffer.from(file.content).toString("base64"),
            executable: file.executable,
          });
        }
        return;
      case "terminal.open": {
        if (this.sessions.size >= 16) throw new Error("Terminal limit reached.");
        const opened = await provider.terminal!.open(computer, action, { ...context, ...action });
        this.sessions.set(opened.id, {
          provider,
          spaceId: context.spaceId,
          homeKey: operation.homeKey,
          connectionId: operation.connectionId,
          leaseId: action.leaseId,
          expiresAt: action.expiresAt,
        });
        return send("result", opened);
      }
      case "terminal.write":
        return provider.terminal!.write(action.sessionId, Buffer.from(action.content, "base64"));
      case "terminal.resize":
        return provider.terminal!.resize(action.sessionId, action.cols, action.rows);
      case "terminal.close":
        this.sessions.delete(action.sessionId);
        return provider.terminal!.close(action.sessionId, "closed");
      case "terminal.output":
        for await (const frame of provider.terminal!.output(action.sessionId))
          await send("result", {
            seq: frame.seq,
            content: Buffer.from(frame.bytes).toString("base64"),
          });
        return;
      case "terminal.revoke":
        for (const [id, session] of this.sessions)
          if (
            session.spaceId === context.spaceId &&
            session.homeKey === operation.homeKey &&
            session.leaseId === action.leaseId
          )
            this.sessions.delete(id);
        return provider.terminal!.revoke(computer, action.leaseId, context);
    }
  }
}
