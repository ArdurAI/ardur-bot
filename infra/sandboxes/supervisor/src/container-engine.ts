import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
export function discoverEngineSocket(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  exists = existsSync,
  machineInspect = () =>
    execFileSync("podman", ["machine", "inspect"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }),
) {
  const configured = env.DOCKER_SOCKET || env.CONTAINER_HOST || env.DOCKER_HOST;
  if (configured) return socketPath(configured);
  if (platform === "win32") return "//./pipe/docker_engine";
  const docker =
    platform === "darwin"
      ? path.join(homedir(), ".docker/run/docker.sock")
      : "/var/run/docker.sock";
  if (exists(docker)) return docker;
  if (platform === "darwin") {
    try {
      const machines = JSON.parse(machineInspect()) as {
        State?: string;
        ConnectionInfo?: { PodmanSocket?: { Path?: string } };
      }[];
      const socket = machines.find((machine) => machine.State === "running")?.ConnectionInfo
        ?.PodmanSocket?.Path;
      if (socket && exists(socket)) return socketPath(socket);
    } catch {
      /* An absent CLI or stopped machine is not an engine. */
    }
  }
  const rootless = `${env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`}/podman/podman.sock`;
  return exists(rootless) ? rootless : "/var/run/docker.sock";
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
