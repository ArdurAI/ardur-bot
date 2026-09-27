import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { expect, it, vi } from "vitest";
import {
  discoverFleet,
  dockerContextName,
  parseDockerContexts,
  parseTailscalePeers,
} from "./discovery.js";
import { engineCommand } from "./docker-sandbox.js";
import { probeEngineEndpoint } from "./probe.js";
import type { FleetProcess } from "./process.js";

it("reads JSON-lines Docker contexts and preserves every Kubernetes context", async () => {
  expect(
    parseDockerContexts(
      '{"Name":"local","DockerEndpoint":"unix:///fixture/engine.sock"}\n{"Name":"remote","DockerEndpoint":"ssh://runner@computer.invalid"}',
    ).map((target) => target.context),
  ).toEqual(["local", "remote"]);
  const processes = {
    start: vi.fn(),
    run: vi.fn(async (name) => ({
      code: name === "kubectl" ? 0 : 1,
      stdout: Buffer.from('{"contexts":[{"name":"kind-test"},{"name":"cluster-test"}]}'),
      stderr: Buffer.alloc(0),
    })),
  } as FleetProcess;
  expect(
    (await discoverFleet(processes))
      .filter((target) => target.kind === "kubernetes")
      .map((target) => target.context),
  ).toEqual(["kind-test", "cluster-test"]);
});
it("names Docker contexts by their actual engine and profile", () => {
  expect(dockerContextName("desktop-linux")).toContain("Docker Desktop");
  expect(dockerContextName("orbstack")).toContain("OrbStack");
  expect(dockerContextName("colima")).toContain("Colima (default)");
  expect(dockerContextName("colima-atrium-beta")).toContain("Colima (atrium-beta)");
  expect(dockerContextName("kind-ardur-test")).toBe("kind (ardur-test)");
});
it.each([
  ["answered", { code: 0, stderr: "" }, "running", undefined],
  [
    "refused",
    { code: 1, stderr: "connection refused" },
    "installed-not-running",
    "engine-not-running",
  ],
  [
    "missing",
    { code: 1, stderr: "no such file or directory" },
    "installed-not-running",
    "socket-missing",
  ],
  ["timeout", { code: 1, stderr: "timed out" }, "installed-not-running", "timed-out"],
] as const)("classifies a %s engine probe", async (_case, result, status, reason) => {
  const run = vi.fn(async (_name: string, _argv: string[]) => ({
    code: result.code,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(result.stderr),
  }));
  const probed = await probeEngineEndpoint(
    { kind: "docker", endpoint: "unix:///fixture/engine.sock" },
    { run, start: vi.fn() } as FleetProcess,
  );
  expect(probed).toMatchObject({ status, ...(reason ? { reason } : {}) });
  expect(run.mock.calls[0]?.[1]).toEqual([
    "--host",
    "unix:///fixture/engine.sock",
    "info",
    "--format",
    "{{json .}}",
  ]);
});
it("lists only online Linux peers, with MagicDNS, IP and advertised Tailscale SSH", () => {
  const peers = parseTailscalePeers(
    JSON.stringify({
      BackendState: "Running",
      Peer: {
        one: {
          ID: "peer",
          Online: true,
          OS: "linux",
          DNSName: "peer.example.invalid.",
          TailscaleIPs: ["100.64.0.2"],
          Tags: ["tag:ardurbot-user-runner"],
          sshHostKeys: ["public-host-key"],
        },
        two: { Online: true, OS: "linux", TailscaleIPs: ["100.64.0.3"], Tags: ["tag:server"] },
        three: { Online: false, OS: "linux", TailscaleIPs: ["100.64.0.4"] },
        four: { Online: true, OS: "windows", TailscaleIPs: ["100.64.0.5"] },
      },
    }),
    "localuser",
  );
  expect(peers).toHaveLength(2);
  expect(peers[0]).toMatchObject({
    name: "peer.example.invalid",
    endpoint: "100.64.0.2",
    ssh: { authentication: "tailscale", user: "runner" },
  });
  expect(peers[1]?.ssh).toMatchObject({ authentication: "agent", user: "localuser" });
  expect(parseTailscalePeers('{"BackendState":"NeedsLogin"}', "runner")).toEqual([]);
});
it("selects the request's engine without exporting SSH keys or disabling TLS", () => {
  const remote = engineCommand(
    ComputerConnectionSettingsSchema.parse({
      engine: "docker",
      endpoint: "ssh://runner@computer.invalid:2222",
    }),
  );
  expect(remote).toMatchObject({ name: "ssh", remote: true });
  expect(remote.prefix).toEqual(
    expect.arrayContaining(["BatchMode=yes", "2222", "runner@computer.invalid"]),
  );
  const settings = ComputerConnectionSettingsSchema.parse({
    engine: "docker",
    endpoint: "tcp://computer.invalid:2376",
  });
  expect(() => engineCommand(settings)).toThrow("TLS");
  expect(engineCommand(settings, "/fixture/certificates").prefix).toContain("--tlsverify");
  expect(
    engineCommand(
      ComputerConnectionSettingsSchema.parse({
        engine: "podman",
        endpoint: "unix:///fixture/podman.sock",
      }),
    ).name,
  ).toBe("podman");
});

it("uses each CLI's socket and TLS flags without accepting unauthenticated TCP", () => {
  for (const engine of ["docker", "podman"] as const) {
    const settings = ComputerConnectionSettingsSchema.parse({
      engine,
      endpoint: "/fixture/engine.sock",
    });
    expect(engineCommand(settings).prefix).toEqual([
      engine === "podman" ? "--url" : "--host",
      "unix:///fixture/engine.sock",
    ]);
    const tls = engineCommand(
      { ...settings, endpoint: "tcp://computer.invalid:2376" },
      "/fixture/tls",
    );
    expect(tls.prefix).toContain(engine === "podman" ? "--tls-ca" : "--tlscacert");
    expect(tls.prefix).toContain(engine === "podman" ? "--tls-key" : "--tlskey");
    expect(
      ComputerConnectionSettingsSchema.safeParse({
        engine,
        endpoint: "tcp://computer.invalid:2375",
      }).success,
    ).toBe(false);
  }
});
