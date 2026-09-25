import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import type { FleetTarget } from "@ardurbot/contracts";
import {
  EngineEndpointSchema,
  SshSettingsSchema,
  unknownCapacity,
} from "@ardurbot/contracts/fleet";
import type { FleetProcess } from "./process.js";
import { systemFleetProcess } from "./process.js";

export function parseDockerContexts(output: string): FleetTarget[] {
  const parsed: unknown = output.trim().startsWith("[")
    ? JSON.parse(output)
    : output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
  if (!Array.isArray(parsed)) throw new Error("Invalid Docker context response.");
  return parsed.slice(0, 128).flatMap((item) => {
    if (
      !item ||
      typeof item.Name !== "string" ||
      typeof item.DockerEndpoint !== "string" ||
      !EngineEndpointSchema.safeParse(item.DockerEndpoint).success
    )
      return [];
    return [
      {
        id: `context:${item.Name}`,
        name: item.Name,
        kind: "docker" as const,
        connectionId: null,
        state: "discovered" as const,
        endpoint: item.DockerEndpoint,
        context: item.Name,
        capacity: unknownCapacity(),
        bots: [],
      },
    ];
  });
}

export function parseTailscalePeers(output: string, currentUser: string): FleetTarget[] {
  const status = JSON.parse(output) as {
    BackendState?: string;
    Peer?: Record<
      string,
      {
        ID?: string;
        DNSName?: string;
        OS?: string;
        Online?: boolean;
        TailscaleIPs?: string[];
        Tags?: string[];
        sshHostKeys?: string[];
        Capabilities?: string[];
      }
    >;
  };
  if (status.BackendState !== "Running") return [];
  return Object.values(status.Peer ?? {})
    .slice(0, 512)
    .flatMap((peer) => {
      if (!peer.Online || peer.OS !== "linux" || !peer.TailscaleIPs?.length) return [];
      const host = peer.DNSName?.replace(/\.$/, "") || peer.TailscaleIPs[0];
      // Tags describe ACL roles, not POSIX login names. Only the explicit opt-in convention is used.
      const user =
        peer.Tags?.find((tag) => /^tag:ardurbot-user-[a-z_][a-z0-9_-]*$/.test(tag))?.slice(
          "tag:ardurbot-user-".length,
        ) ?? currentUser;
      const ssh = SshSettingsSchema.safeParse({
        host,
        user,
        authentication: peer.sshHostKeys?.length ? "tailscale" : "agent",
      });
      if (!ssh.success) return [];
      return [
        {
          id: `tailscale:${peer.ID ?? host}`,
          name: host!,
          kind: "tailscale" as const,
          connectionId: null,
          state: "discovered" as const,
          endpoint: peer.TailscaleIPs[0],
          ssh: ssh.data,
          capacity: unknownCapacity(),
          bots: [],
        },
      ];
    });
}

export async function discoverFleet(
  processes: FleetProcess = systemFleetProcess,
): Promise<FleetTarget[]> {
  const targets: FleetTarget[] = [];
  for (const [name, socket, kind] of [
    ["Docker on this Mac", path.join(homedir(), ".docker/run/docker.sock"), "docker"],
    ["OrbStack", path.join(homedir(), ".orbstack/run/docker.sock"), "docker"],
    ["Colima", path.join(homedir(), ".colima/default/docker.sock"), "docker"],
    ["Docker", "/var/run/docker.sock", "docker"],
    [
      "Podman",
      `${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`}/podman/podman.sock`,
      "podman",
    ],
  ] as const)
    if (existsSync(socket))
      targets.push({
        id: `socket:${socket}`,
        name,
        kind,
        connectionId: null,
        state: "discovered",
        endpoint: socket.startsWith("unix://") ? socket : `unix://${socket}`,
        capacity: unknownCapacity(),
        bots: [],
      });
  const results = await Promise.allSettled([
    processes
      .run(
        "kubectl",
        ["config", "view", "--output=json"],
        AbortSignal.timeout(5000),
        undefined,
        1024 * 1024,
      )
      .then((result): FleetTarget[] => {
        if (result.code !== 0) return [];
        const config = JSON.parse(result.stdout.toString()) as {
          contexts?: { name: string; context?: { cluster?: string } }[];
        };
        return (config.contexts ?? [])
          .slice(0, 128)
          .filter((entry) => typeof entry.name === "string")
          .map((entry) => ({
            id: `kubernetes:${entry.name}`,
            name: entry.name,
            kind: "kubernetes",
            context: entry.name,
            state: "discovered",
            connectionId: null,
            capacity: unknownCapacity(),
            bots: [],
          }));
      }),
    processes
      .run(
        "docker",
        ["context", "ls", "--format", "json"],
        AbortSignal.timeout(5000),
        undefined,
        512 * 1024,
      )
      .then((result) => (result.code === 0 ? parseDockerContexts(result.stdout.toString()) : [])),
    processes
      .run("tailscale", ["status", "--json"], AbortSignal.timeout(5000), undefined, 1024 * 1024)
      .then((result) =>
        result.code === 0 ? parseTailscalePeers(result.stdout.toString(), userInfo().username) : [],
      ),
    processes
      .run("podman", ["machine", "inspect"], AbortSignal.timeout(5000), undefined, 512 * 1024)
      .then((result): FleetTarget[] => {
        if (result.code !== 0) return [];
        const machines = JSON.parse(result.stdout.toString()) as {
          State?: string;
          ConnectionInfo?: { PodmanSocket?: { Path?: string } };
        }[];
        return machines.flatMap((machine) => {
          const socket = machine.ConnectionInfo?.PodmanSocket?.Path;
          return machine.State === "running" &&
            socket &&
            EngineEndpointSchema.safeParse(socket).success
            ? [
                {
                  id: `socket:${socket}`,
                  name: "Podman",
                  kind: "podman",
                  connectionId: null,
                  state: "discovered",
                  endpoint: socket.startsWith("unix://") ? socket : `unix://${socket}`,
                  capacity: unknownCapacity(),
                  bots: [],
                },
              ]
            : [];
        });
      }),
  ]);
  for (const result of results) if (result.status === "fulfilled") targets.push(...result.value);
  return targets.filter(
    (target, index) =>
      targets.findIndex(
        (other) =>
          other.id === target.id ||
          (target.endpoint && other.kind === target.kind && other.endpoint === target.endpoint),
      ) === index,
  );
}
