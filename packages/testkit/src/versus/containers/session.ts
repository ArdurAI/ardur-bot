import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { contentDigest } from "../../scoreboard/manifest.js";
import type { Budget } from "../budget.js";
import { requireValue } from "../budget.js";
import { createTrialDirectory, destroyOwnedDirectory } from "../isolation.js";
import { sanitize } from "../provenance.js";
import { CONTAINER_GUEST, SYMLINK_REFUSAL } from "./guest.js";
import type { ContainerInspection, ContainerPolicy, ContainerProof } from "./policy.js";
import {
  CONTAINER_ROOT,
  CONTAINER_SECCOMP,
  containerPolicy,
  HERMES_IMAGE,
  HERMES_PULL,
  validateContainerInspection,
} from "./policy.js";

const executeFile = promisify(execFile);
const EXEC_WRAPPER = `
import os, sys
os.umask(0o007)
pidfile = os.environ.get("ARDURBOT_EXEC_PID")
if pidfile:
    try:
        os.setsid()
    except OSError:
        try:
            os.setpgid(0, 0)
        except OSError:
            pass
    fd = os.open(pidfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
os.execv(sys.argv[1], sys.argv[1:])
`;
const SIGNAL_GUEST = `
import os, signal, sys, time
path = sys.argv[1]
deadline = time.monotonic() + 2
pid = 0
while time.monotonic() < deadline:
    try:
        pid = int(open(path).read())
        break
    except FileNotFoundError:
        time.sleep(0.05)
    except (OSError, ValueError):
        pid = 0
        break
if pid <= 1:
    raise SystemExit(0)
def gone():
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return True
    return False
if not gone():
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
for _ in range(40):
    if gone():
        raise SystemExit(0)
    time.sleep(0.05)
raise SystemExit(1)
`;
async function localEndpoint() {
  const explicit = process.env.DOCKER_CONTEXT;
  const endpoint =
    !explicit && process.env.DOCKER_HOST
      ? process.env.DOCKER_HOST
      : (
          await executeFile(
            "docker",
            [
              "context",
              "inspect",
              ...(explicit ? [explicit] : []),
              "--format",
              '{{(index .Endpoints "docker").Host}}',
            ],
            { encoding: "utf8", timeout: 10000, maxBuffer: 4096 },
          )
        ).stdout.trim();
  requireValue(endpoint.startsWith("unix://"), "Only a local Docker engine is allowed");
  return endpoint;
}
export async function docker(args: string[], timeout = 20000, endpoint?: string) {
  const result = await executeFile(
    "docker",
    ["--host", endpoint ?? (await localEndpoint()), ...args],
    {
      encoding: "utf8",
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return result.stdout.trim();
}
export async function inspectImage(image: string, endpoint?: string) {
  requireValue(
    /^(?:[a-z0-9./-]+@)?sha256:[a-f0-9]{64}$/.test(image),
    "Pinned container image required",
  );
  let data: {
    Id: string;
    Architecture: string;
    Os: string;
    Config: { Labels?: Record<string, string> };
  };
  try {
    data = JSON.parse(await docker(["image", "inspect", image], 20000, endpoint))[0];
  } catch (error) {
    requireValue(
      /No such image|No such object/i.test(String((error as { stderr?: string }).stderr)),
      "Local image inspection unavailable; cached-image presence was not established",
    );
    throw new Error(
      image === HERMES_IMAGE
        ? `Pinned Hermes image absent. Owner must approve: ${HERMES_PULL}`
        : "Cached stand-in/computer image absent; no pull is permitted",
    );
  }
  requireValue(data.Os === "linux" && data.Architecture === "arm64", "Image platform drift");
  return {
    id: data.Id,
    platform: "linux/arm64" as const,
    revision: data.Config.Labels?.["org.opencontainers.image.revision"] ?? null,
  };
}
const issued = new WeakMap<ContainerProof, { id: string; policyHash: string }>();
export function assertContainerProof(proof: ContainerProof, policy: ContainerPolicy, id: string) {
  const value = issued.get(proof);
  requireValue(
    value?.id === id && value.policyHash === contentDigest(policy),
    "Unissued or mismatched container proof",
  );
}
type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };
export class ContainerSession {
  readonly id: string;
  readonly policy: Readonly<ContainerPolicy>;
  proof!: ContainerProof;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Waiter>();
  private buffer = "";
  private active = true;
  private relay: { providerUrl: string; brokerUrl: string } | null = null;
  private requests = new Set<AbortController>();
  private timer: NodeJS.Timeout | undefined;
  private cleanup: Promise<void> | null = null;
  private readonly execPids = new WeakMap<object, string>();
  private constructor(
    private readonly resource: Awaited<ReturnType<typeof createTrialDirectory>>,
    policy: ContainerPolicy,
    id: string,
    private readonly endpoint: string,
  ) {
    this.id = id;
    this.policy = policy;
  }
  static async open(options: {
    root: string;
    image: string;
    budget: Budget;
    wallMs: number;
  }): Promise<ContainerSession> {
    const endpoint = await localEndpoint();
    const image = await inspectImage(options.image, endpoint);
    const policy = containerPolicy(options.image, image.id, options.budget, options.wallMs);
    const info = JSON.parse(await docker(["info", "--format", "{{json .}}"], 20000, endpoint));
    requireValue(info.CgroupVersion === "2", "cgroup v2 is required");
    await mkdir(options.root, { recursive: true });
    const resource = await createTrialDirectory(options.root);
    const profile = path.join(resource.state, "seccomp.json");
    await writeFile(profile, JSON.stringify(CONTAINER_SECCOMP), { flag: "wx" });
    const name = `versus-${randomUUID()}`;
    let session: ContainerSession | undefined;
    try {
      const id = await docker(
        [
          "create",
          "--pull=never",
          "--name",
          name,
          "--label",
          `ardur.versus.owner=${resource.owner}`,
          "--label",
          `ardur.versus.policy=${contentDigest(policy)}`,
          "--platform",
          policy.platform,
          "--user",
          policy.user,
          "--network",
          "none",
          "--ipc",
          "none",
          "--cgroupns",
          "private",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--security-opt",
          `seccomp=${profile}`,
          "--memory",
          String(policy.memoryBytes),
          "--memory-swap",
          String(policy.memoryBytes),
          "--pids-limit",
          String(policy.processes),
          "--cpu-period",
          String(policy.cpuPeriodUs),
          "--cpu-quota",
          String(policy.cpuQuotaUs),
          "--log-driver",
          "none",
          "--tmpfs",
          `${CONTAINER_ROOT}:rw,nosuid,nodev,noexec,size=${policy.diskBytes},mode=770,uid=65531,gid=65532`,
          "--env",
          `VERSUS_WALL_MS=${policy.wallMs}`,
          "--env",
          `HOME=${CONTAINER_ROOT}/home`,
          "--env",
          `TMPDIR=${CONTAINER_ROOT}/tmp`,
          "--interactive",
          "--entrypoint",
          "/usr/bin/python3",
          image.id,
          "-I",
          "-S",
          "-u",
          "-c",
          CONTAINER_GUEST,
        ],
        20000,
        endpoint,
      );
      requireValue(/^[a-f0-9]{64}$/.test(id), "Invalid created container identity");
      session = new ContainerSession(resource, policy, id, endpoint);
      // Record ownership before startup so an interrupted invocation can recover only its resources.
      await writeFile(
        path.join(resource.state, "container.json"),
        JSON.stringify({ id, owner: resource.owner, policy }),
        { flag: "wx" },
      );
      await session.start();
      return session;
    } catch (error) {
      if (session) await session.destroy();
      else {
        const ids = (
          await docker(
            ["ps", "-aq", "--filter", `label=ardur.versus.owner=${resource.owner}`],
            20000,
            endpoint,
          )
        )
          .split("\n")
          .filter(Boolean);
        for (const id of ids) await docker(["rm", "-f", id], 20000, endpoint);
        await destroyOwnedDirectory(resource);
      }
      throw error;
    }
  }
  private async start() {
    const ready = new Promise<unknown>((resolve, reject) =>
      this.pending.set("ready", { resolve, reject }),
    );
    this.child = spawn(
      "docker",
      ["--host", this.endpoint, "start", "--attach", "--interactive", this.id],
      {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 4 * 1024 * 1024) {
        this.fail("Container relay byte limit");
        return;
      }
      let index = this.buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.fail("Malformed container relay");
        }
        index = this.buffer.indexOf("\n");
      }
    });
    let stderr = "";
    this.child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + sanitize(chunk.toString())).slice(-4000);
    });
    this.child.once("error", () => this.fail("Container attach failed"));
    this.child.once("close", () => this.fail(`Container exited: ${stderr}`));
    const startup = setTimeout(() => this.fail("Container startup deadline"), 15000);
    this.timer = setTimeout(() => {
      void this.destroy();
    }, this.policy.wallMs + 1000);
    try {
      const group = (await ready) as Record<string, string>;
      const inspection = await this.inspect();
      validateContainerInspection(this.policy, inspection, this.resource.owner);
      requireValue(
        group["memory.max"] === String(this.policy.memoryBytes) &&
          group["memory.swap.max"] === "0" &&
          group["pids.max"] === String(this.policy.processes) &&
          group["cpu.max"] === `${this.policy.cpuQuotaUs} ${this.policy.cpuPeriodUs}` &&
          group["cgroup.controllers"]?.includes("memory"),
        "Observed cgroup does not enforce policy",
      );
      this.proof = Object.freeze({
        mechanism: "linux-cgroup-v2",
        policyHash: contentDigest(this.policy),
        containerHash: contentDigest(inspection),
        ownership: Object.freeze({ id: this.id, label: this.resource.owner }),
        cgroup: Object.freeze({ ...group }),
      });
      issued.set(this.proof, { id: this.id, policyHash: contentDigest(this.policy) });
    } finally {
      clearTimeout(startup);
    }
  }
  private receive(message: Record<string, unknown>) {
    if (message.kind === "http") {
      void this.forward(message).catch(() => this.fail("Container relay failure"));
      return;
    }
    const id = message.kind === "ready" ? "ready" : String(message.id);
    const pending = this.pending.get(id);
    requireValue(pending, "Unsolicited container control reply");
    this.pending.delete(id);
    if (message.error) {
      const detail = String(message.error);
      pending.reject(
        new Error(detail === SYMLINK_REFUSAL ? detail : `Container operation refused: ${detail}`),
      );
    } else pending.resolve(message.kind === "ready" ? message.cgroup : message.value);
  }
  private send(value: unknown) {
    requireValue(this.active && this.child, "Container closed");
    const wire = JSON.stringify(value);
    requireValue(Buffer.byteLength(wire) <= 4 * 1024 * 1024, "Container message limit");
    this.child.stdin.write(`${wire}\n`);
  }
  private fail(reason: string) {
    this.active = false;
    for (const waiter of this.pending.values()) waiter.reject(new Error(reason));
    this.pending.clear();
    for (const request of this.requests) request.abort();
  }
  bindRelay(providerUrl: string, brokerUrl: string) {
    requireValue(!this.relay, "Container route already frozen");
    for (const endpoint of [providerUrl, brokerUrl]) {
      const url = new URL(endpoint);
      requireValue(
        url.protocol === "http:" &&
          url.hostname === "127.0.0.1" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash,
        "Relay only forwards to controller loopback capabilities",
      );
    }
    this.relay = Object.freeze({ providerUrl, brokerUrl });
    return {
      providerUrl: "http://127.0.0.1:18080/provider",
      brokerUrl: "http://127.0.0.1:18080/broker",
    };
  }
  private async forward(message: Record<string, unknown>) {
    const reply = (data: unknown) => {
      if (this.active) this.send({ kind: "http-result", id: message.id, ...(data as object) });
    };
    const control = new AbortController();
    this.requests.add(control);
    const timer = setTimeout(() => control.abort(), Math.min(120000, this.policy.wallMs));
    try {
      requireValue(
        this.relay &&
          this.requests.size <= 8 &&
          typeof message.id === "string" &&
          /^[a-f0-9]{32}$/.test(message.id),
        "Unbound or overloaded relay",
      );
      const route = message.path;
      requireValue(
        ["/provider/chat/completions", "/provider/models", "/broker"].includes(String(route)),
        "Relay route denied",
      );
      requireValue(
        ["GET", "POST", "DELETE"].includes(String(message.method)) &&
          typeof message.body === "string" &&
          message.body.length <= 3 * 1024 * 1024,
        "Relay request denied",
      );
      const url =
        route === "/broker"
          ? this.relay.brokerUrl
          : `${this.relay.providerUrl}/${String(route).slice(10)}`;
      const allowedHeaders = new Headers();
      for (const [key, value] of Object.entries(message.headers as Record<string, string>))
        if (
          ["content-type", "accept", "mcp-session-id", "mcp-protocol-version"].includes(
            key.toLowerCase(),
          )
        )
          allowedHeaders.set(key, String(value));
      const result = await fetch(url, {
        method: String(message.method),
        headers: allowedHeaders,
        body: message.method === "GET" ? undefined : Buffer.from(message.body, "base64"),
        redirect: "error",
        signal: control.signal,
      });
      reply({
        status: result.status,
        headers: {
          "content-type": result.headers.get("content-type") ?? "application/json",
          ...(result.headers.has("mcp-session-id")
            ? { "mcp-session-id": result.headers.get("mcp-session-id") }
            : {}),
        },
      });
      let bytes = 0;
      for await (const chunk of result.body ?? []) {
        bytes += chunk.length;
        requireValue(bytes <= 4 * 1024 * 1024, "Relay response limit");
        reply({ chunk: Buffer.from(chunk).toString("base64") });
      }
    } catch {
      reply({ status: 403, headers: {} });
    } finally {
      reply({ end: true });
      clearTimeout(timer);
      this.requests.delete(control);
    }
  }
  async inspect(): Promise<ContainerInspection> {
    return JSON.parse(await docker(["inspect", this.id], 20000, this.endpoint))[0];
  }
  async assertReady() {
    requireValue(this.active, "Container no longer running");
    assertContainerProof(this.proof, this.policy, this.id);
    validateContainerInspection(this.policy, await this.inspect(), this.resource.owner);
  }
  async file(
    op: "read" | "write" | "mkdir" | "list" | "snapshot",
    file: string,
    content?: Uint8Array,
  ): Promise<unknown> {
    requireValue(this.active, "Container closed");
    const id = randomUUID();
    const result = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    try {
      this.send({
        kind: "file",
        id,
        op,
        path: file,
        ...(content ? { data: Buffer.from(content).toString("base64") } : {}),
      });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return result;
  }
  async write(file: string, content: string | Uint8Array) {
    await this.file("write", file, typeof content === "string" ? Buffer.from(content) : content);
  }
  async read(file: string) {
    return Buffer.from((await this.file("read", file)) as string, "base64");
  }
  async snapshot(directory = "workspace") {
    return (await this.file("snapshot", directory)) as Record<string, string>;
  }
  /** The trusted caller must reserve a semantic tool/descendant before starting product-requested work. */
  async exec(
    argv: string[],
    options: { env?: Record<string, string>; cwd?: string; signal?: AbortSignal } = {},
  ) {
    options.signal?.throwIfAborted();
    await this.assertReady();
    options.signal?.throwIfAborted();
    requireValue(
      argv.length > 0 && argv[0]!.startsWith("/") && argv.every((arg) => !arg.includes("\0")),
      "Container command must have an absolute executable",
    );
    const execId = randomUUID();
    const pidFile = `${CONTAINER_ROOT}/tmp/ardurbot-exec-${execId}.pid`;
    const env = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: `${CONTAINER_ROOT}/home`,
      PYTHONDONTWRITEBYTECODE: "1",
      HERMES_HOME: `${CONTAINER_ROOT}/state`,
      HERMES_DISABLE_LAZY_INSTALLS: "1",
      ...options.env,
      // The activity marker and product temp files share the bounded tmpfs, never the read-only /tmp.
      TMPDIR: `${CONTAINER_ROOT}/tmp`,
      ARDURBOT_BACKGROUND_DIR: `${CONTAINER_ROOT}/tmp`,
      ARDURBOT_EXEC_PID: pidFile,
    };
    const cwd = options.cwd ?? `${CONTAINER_ROOT}/workspace`;
    requireValue(
      cwd === CONTAINER_ROOT || cwd.startsWith(`${CONTAINER_ROOT}/`),
      "Command cwd outside trial",
    );
    options.signal?.throwIfAborted();
    // Product and relay stay distinct users. The shared-group mask lets the relay update product files.
    const child = spawn(
      "docker",
      [
        "--host",
        this.endpoint,
        "exec",
        "--user",
        this.policy.productUser,
        "--workdir",
        cwd,
        this.id,
        "/usr/bin/env",
        "-i",
        ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
        "/usr/bin/python3",
        "-I",
        "-S",
        "-u",
        "-c",
        EXEC_WRAPPER,
        ...argv,
      ],
      {
        shell: false,
        detached: true,
        // Abort must not kill only this client. The guest keeps running until signalGuest.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.execPids.set(child, pidFile);
    return child;
  }
  /** Signal the tagged guest process group. Container removal remains the backstop. */
  async signalGuest(child: object): Promise<void> {
    const pidFile = this.execPids.get(child);
    if (!pidFile || !this.active) return;
    await docker(
      [
        "exec",
        "--user",
        this.policy.productUser,
        "--workdir",
        CONTAINER_ROOT,
        this.id,
        "/usr/bin/python3",
        "-I",
        "-S",
        "-c",
        SIGNAL_GUEST,
        pidFile,
      ],
      5000,
      this.endpoint,
    ).catch(() => undefined);
  }
  destroy() {
    this.cleanup ??= this.destroyOwned();
    return this.cleanup;
  }
  private async destroyOwned() {
    clearTimeout(this.timer);
    this.fail("Owned container destroyed");
    const metadata = await this.inspect().catch((error: { stderr?: string }) => {
      // A daemon failure leaves the ownership record intact for recovery.
      if (/No such container|No such object/i.test(String(error.stderr))) return null;
      throw error;
    });
    if (metadata) {
      requireValue(
        metadata.Config.Labels["ardur.versus.owner"] === this.resource.owner,
        "Cleanup ownership mismatch",
      );
      await docker(["rm", "-f", this.id], 20000, this.endpoint);
    }
    this.child?.stdin.destroy();
    await destroyOwnedDirectory(this.resource);
  }
}
