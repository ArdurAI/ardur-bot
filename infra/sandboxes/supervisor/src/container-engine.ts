import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

export type ContainerEngine = { name: "docker" | "podman"; rootless: boolean };
export function engineFromResponses(version: unknown, info: unknown): ContainerEngine {
  const text = JSON.stringify(version).toLowerCase();
  const details = info as {
    SecurityOptions?: string[];
    host?: { security?: { rootless?: boolean } };
  };
  return {
    name: text.includes("podman") ? "podman" : "docker",
    rootless:
      details.host?.security?.rootless === true ||
      (details.SecurityOptions ?? []).some((value) => value.includes("rootless")),
  };
}
export function socketPath(value: string) {
  const socket = value.startsWith("unix://") ? value.slice(7) : value;
  if (!path.isAbsolute(socket) || socket.includes("\0") || socket.includes("://")) {
    throw new Error("Choose a local Unix engine socket.");
  }
  return socket;
}
export async function discoverEngineSocket(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  probe: (socket: string) => boolean | Promise<boolean> = probeEngineSocket,
  machineInspect = () =>
    execFileSync("podman", ["machine", "inspect"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  contextInspect = () =>
    execFileSync("docker", ["context", "inspect"], {
      env,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }),
) {
  const configured = env.DOCKER_SOCKET || env.CONTAINER_HOST || env.DOCKER_HOST;
  if (configured) return socketPath(configured);
  if (platform === "win32") return "//./pipe/docker_engine";
  try {
    const contexts = JSON.parse(contextInspect()) as {
      Endpoints?: { docker?: { Host?: string } };
    }[];
    const host = contexts[0]?.Endpoints?.docker?.Host;
    if (host) {
      const socket = socketPath(host);
      if (await probe(socket)) return socket;
    }
  } catch {
    /* An absent CLI or remote context does not identify a local engine. */
  }
  const docker =
    platform === "darwin"
      ? path.join(homedir(), ".docker/run/docker.sock")
      : "/var/run/docker.sock";
  if (await probe(docker)) return docker;
  if (platform === "darwin") {
    for (const candidate of [".orbstack/run/docker.sock", ".colima/default/docker.sock"]) {
      const socket = path.join(homedir(), candidate);
      if (exists(socket)) return socket;
    }
    try {
      const machines = JSON.parse(machineInspect()) as {
        State?: string;
        ConnectionInfo?: { PodmanSocket?: { Path?: string } };
      }[];
      const socket = machines.find((machine) => machine.State === "running")?.ConnectionInfo
        ?.PodmanSocket?.Path;
      if (socket && (await probe(socketPath(socket)))) return socketPath(socket);
    } catch {
      /* An absent CLI or stopped machine is not an engine. */
    }
  }
  const rootless = `${env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`}/podman/podman.sock`;
  return (await probe(rootless)) ? rootless : "/var/run/docker.sock";
}
export function engineUser(engine: ContainerEngine, fallback: string) {
  return engine.name === "podman" && engine.rootless ? "1000:1000" : fallback;
}
export function engineHostConfig(engine: ContainerEngine) {
  // Map the rootless service owner to the image's non-root computer identity.
  return engine.name === "podman" && engine.rootless
    ? { UsernsMode: "keep-id:uid=1000,gid=1000" }
    : {};
}

function probeEngineSocket(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ socketPath: socket, path: "/_ping", timeout: 1000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}
