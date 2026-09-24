import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
import type { ComputerConnectionSettings } from "@ardurbot/contracts";
import { computerImage, profileCommandError } from "@ardurbot/contracts";
import { boundedSandboxCommandTimeoutMs } from "@ardurbot/core";
import { normalizeWorkspacePath } from "./computer-support.js";
import type { KubernetesApi, KubernetesObject } from "./kubernetes-client.js";
import { KUBERNETES_FILE_SCRIPT } from "./kubernetes-files.js";

const HOME = "/home/ardurbot";
const UNAVAILABLE = "Not available on this computer";
const MAX_FILE = 16 * 1024 * 1024;
export const KUBERNETES_CAPABILITIES = {
  graphical: false,
  pty: false,
  interactiveTerminal: false,
  snapshots: true,
  takeover: false,
  persistentHome: true,
  multiScreen: false,
};

export function kubernetesComputerName(spaceId: string, botId: string) {
  return `ardurbot-${createHash("sha256").update(`${spaceId}\0${botId}`).digest("hex").slice(0, 32)}`;
}
export function kubernetesComputerSpec(
  name: string,
  profile: ComputerRef["imageProfile"],
  settings: ComputerConnectionSettings,
): KubernetesObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, labels: { "ardurbot.com/computer": name } },
    spec: {
      restartPolicy: "Always",
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "computer",
          image: computerImage(profile),
          imagePullPolicy: "IfNotPresent",
          command: ["/bin/sleep", "infinity"],
          workingDir: HOME,
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          resources: {
            requests: { cpu: settings.cpuRequest, memory: settings.memoryRequest },
            limits: { cpu: settings.cpuLimit, memory: settings.memoryLimit },
          },
          volumeMounts: [
            { name: "home", mountPath: HOME },
            { name: "shm", mountPath: "/dev/shm" },
          ],
        },
      ],
      volumes: [
        { name: "home", persistentVolumeClaim: { claimName: name } },
        { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
      ],
    },
  };
}

export class KubernetesSandboxProvider implements SandboxProvider {
  constructor(
    private readonly api: KubernetesApi,
    private readonly settings: ComputerConnectionSettings,
  ) {}
  describe() {
    return {
      id: "kubernetes",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: KUBERNETES_CAPABILITIES,
    };
  }
  private name(computer: ComputerRef, context: AdapterContext) {
    const name = kubernetesComputerName(context.spaceId, computer.botId);
    if (computer.providerRef !== name)
      throw new Error("Computer does not belong to this workspace.");
    return name;
  }
  private async owned(
    resource: "pods" | "persistentvolumeclaims",
    name: string,
    signal: AbortSignal,
  ) {
    const object = await this.api.read(resource, name, signal);
    if (object && object.metadata?.labels?.["ardurbot.com/computer"] !== name)
      throw new Error("Kubernetes computer identity does not match.");
    return object;
  }
  async provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const name = kubernetesComputerName(context.spaceId, request.botId);
    const pvc = await this.owned("persistentvolumeclaims", name, context.signal);
    if (!pvc)
      await this.api.create(
        "persistentvolumeclaims",
        {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: { name, labels: { "ardurbot.com/computer": name } },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: this.settings.storageSize } },
            ...(this.settings.storageClass ? { storageClassName: this.settings.storageClass } : {}),
          },
        },
        context.signal,
      );
    let pod = await this.owned("pods", name, context.signal);
    if (pod?.metadata?.deletionTimestamp) {
      await this.waitAbsent(name, context);
      pod = null;
    }
    if (pod) {
      const containers = pod.spec?.containers as { name?: string; image?: string }[] | undefined;
      if (
        containers?.find((container) => container.name === "computer")?.image !==
        computerImage(request.imageProfile ?? "base")
      )
        throw new Error(
          "The computer image differs from its saved profile; confirm an update in Settings.",
        );
    }
    if (!pod)
      await this.api.create(
        "pods",
        kubernetesComputerSpec(name, request.imageProfile ?? "base", this.settings),
        context.signal,
      );
    return {
      id: name,
      providerRef: name,
      kind: "kubernetes",
      botId: request.botId,
      imageProfile: request.imageProfile ?? "base",
      connectionId: request.connectionId,
      fresh: !pvc,
    };
  }
  async prepare(computer: ComputerRef, context: AdapterContext) {
    const name = this.name(computer, context);
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]);
    while (true) {
      const pod = await this.owned("pods", name, signal);
      if (!pod) throw new Error("Kubernetes computer is missing.");
      if (pod.status?.phase === "Failed") throw new Error("Kubernetes computer failed to start.");
      if (
        pod.status?.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        )
      )
        return;
      await delay(250, undefined, { signal });
    }
  }
  async resolveCommandCwd(_computer: ComputerRef, cwd: string | undefined) {
    return `${HOME}/${normalizeWorkspacePath(cwd?.startsWith(`${HOME}/`) ? cwd.slice(HOME.length + 1) : cwd === HOME || cwd === "." ? "" : (cwd ?? ""))}`.replace(
      /\/$/,
      "",
    );
  }
  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (request.pty) throw new Error(UNAVAILABLE);
    const cwd = await this.resolveCommandCwd(computer, request.cwd);
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    // The in-pod timeout also bounds work if the API websocket is disconnected.
    const env = Object.entries(request.env ?? {}).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0"))
        throw new Error("Invalid command environment.");
      return `${key}=${value}`;
    });
    const argv = [
      "timeout",
      "--signal=TERM",
      "--kill-after=2",
      `${timeoutMs / 1000}s`,
      "env",
      ...env,
      "bash",
      "-c",
      'cd -- "$1" && shift && exec "$@"',
      "ardurbot",
      cwd,
      ...request.argv,
    ];
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs + 10_000)]);
    let stderr = "";
    for await (const event of this.api.exec(this.name(computer, context), argv, signal)) {
      if (event.type === "stderr") {
        stderr = (stderr + event.data).slice(-65536);
        yield event;
      } else if (event.type === "exit") {
        const explanation = profileCommandError(
          computer.imageProfile ?? "base",
          request.argv,
          stderr,
          event.code,
        );
        if (explanation !== stderr) yield { type: "stderr", data: `${explanation}\n` };
        yield event;
      } else yield event;
    }
  }
  async connectScreen() {
    return { url: null, mimeType: "text/html", close: async () => undefined };
  }
  async observe(): Promise<ComputerObservation> {
    throw new Error(UNAVAILABLE);
  }
  async act(): Promise<never> {
    throw new Error(UNAVAILABLE);
  }
  async sendInput(): Promise<never> {
    throw new Error(UNAVAILABLE);
  }
  async snapshot(computer: ComputerRef) {
    return { id: computer.providerRef, createdAt: new Date().toISOString() };
  }
  async stop(computer: ComputerRef, context: AdapterContext) {
    const name = this.name(computer, context);
    if (await this.owned("pods", name, context.signal))
      await this.api.remove("pods", name, context.signal);
    await this.waitAbsent(name, context);
  }
  async destroy(computer: ComputerRef, context: AdapterContext) {
    await this.stop(computer, context);
    const name = this.name(computer, context);
    if (await this.owned("persistentvolumeclaims", name, context.signal))
      await this.api.remove("persistentvolumeclaims", name, context.signal);
    await this.waitAbsent(name, context, "persistentvolumeclaims");
  }
  private async waitAbsent(
    name: string,
    context: AdapterContext,
    resource: "pods" | "persistentvolumeclaims" = "pods",
  ) {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]);
    while (await this.owned(resource, name, signal)) await delay(250, undefined, { signal });
  }
  private async fileCommand(
    computer: ComputerRef,
    operation: string,
    path: string,
    context: AdapterContext,
    content = "",
    maxBytes = MAX_FILE,
    executable = false,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new Error("Invalid file size limit.");
    const normalized = normalizeWorkspacePath(path);
    // Python is present in both profiles. Resolve symlinks before allowing file access.
    const script = KUBERNETES_FILE_SCRIPT;
    let stdout = "";
    let size = 0;
    for await (const event of this.api.exec(
      this.name(computer, context),
      ["python3", "-c", script, operation, normalized, "", String(maxBytes), String(executable)],
      AbortSignal.any([context.signal, AbortSignal.timeout(60_000)]),
      operation === "write" ? new Uint8Array(Buffer.from(content, "base64")) : undefined,
    )) {
      if (event.type === "stdout") {
        size += Buffer.byteLength(event.data);
        if (size > Math.ceil((maxBytes * 4) / 3) + 65536)
          throw new Error("File response exceeds limit.");
        stdout += event.data;
      }
      if (event.type === "exit" && event.code !== 0)
        throw new Error("Computer file operation failed.");
    }
    return stdout.trim();
  }
  async listFiles(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    return JSON.parse(await this.fileCommand(computer, "list", path, context));
  }
  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    return new Uint8Array(
      Buffer.from(
        await this.fileCommand(computer, "read", path, context, "", options?.maxBytes ?? MAX_FILE),
        "base64",
      ),
    );
  }
  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    if (file.content.byteLength > MAX_FILE) throw new Error("File exceeds limit.");
    await this.fileCommand(
      computer,
      "write",
      file.path,
      context,
      Buffer.from(file.content).toString("base64"),
      MAX_FILE,
      file.executable,
    );
  }
  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const walk = async function* (
      provider: KubernetesSandboxProvider,
      directory: string,
    ): AsyncIterable<PortableFile> {
      for (const entry of await provider.listFiles(computer, directory, context)) {
        if (entry.kind === "dir") yield* walk(provider, entry.path);
        else
          yield {
            path: entry.path,
            content: await provider.readFile(computer, entry.path, context),
            executable: entry.executable,
          };
      }
    };
    yield* walk(this, "");
  }
  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) await this.writeFile(computer, file, context);
  }
}
