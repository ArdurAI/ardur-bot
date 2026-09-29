import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  containerEngineGuard,
  GUARDED_DATA_DIR_CHILDREN,
  guardrailConfigFromEnv,
  isGuardedPath,
  loopbackPortOf,
  resolveGuardrailPaths,
  resolveGuardrailPathsSync,
  seatbeltArgv,
  seatbeltProfile,
} from "./host-guardrails.js";

const cleanup: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("seatbeltProfile", () => {
  it("allows normal work and denies exactly the given paths and ports", () => {
    const profile = seatbeltProfile({
      paths: ["/srv/stack/.env", "/srv/data/secrets"],
      ports: [7091, 5433],
      sockets: [],
    });
    expect(profile).toBe(
      [
        "(version 1)",
        "(allow default)",
        '(deny file-read* file-write* (subpath "/srv/data/secrets") (subpath "/srv/stack/.env"))',
        '(deny network-outbound (remote ip "localhost:5433") (remote ip "localhost:7091"))',
      ].join("\n"),
    );
  });

  it("denies each engine socket in its own unix-socket filter clause", () => {
    const profile = seatbeltProfile({
      paths: [],
      ports: [],
      sockets: ["/run/engine-b.sock", "/run/engine-a.sock"],
    });
    expect(profile).toBe(
      [
        "(version 1)",
        "(allow default)",
        '(deny network-outbound (remote unix-socket (literal "/run/engine-a.sock")) (remote unix-socket (literal "/run/engine-b.sock")))',
      ].join("\n"),
    );
  });

  it("escapes quotes and backslashes in paths", () => {
    const profile = seatbeltProfile({
      paths: ['/data/odd "quoted" name', "/data/back\\slash"],
      ports: [],
      sockets: [],
    });
    expect(profile).toContain('(subpath "/data/odd \\"quoted\\" name")');
    expect(profile).toContain('(subpath "/data/back\\\\slash")');
  });

  it("fails closed on paths and ports it cannot express", () => {
    expect(() => seatbeltProfile({ paths: ["relative/.env"], ports: [], sockets: [] })).toThrow(
      "Invalid host guardrail path.",
    );
    expect(() => seatbeltProfile({ paths: ["/data/bad\nname"], ports: [], sockets: [] })).toThrow(
      "Invalid host guardrail path.",
    );
    expect(() => seatbeltProfile({ paths: [], ports: [0], sockets: [] })).toThrow(
      "Invalid host guardrail port.",
    );
    expect(() => seatbeltProfile({ paths: [], ports: [65536], sockets: [] })).toThrow(
      "Invalid host guardrail port.",
    );
    expect(() => seatbeltProfile({ paths: [], ports: [5433.5], sockets: [] })).toThrow(
      "Invalid host guardrail port.",
    );
    expect(() =>
      seatbeltProfile({ paths: [], ports: [], sockets: ["relative/docker.sock"] }),
    ).toThrow("Invalid host guardrail path.");
  });

  it("wraps the command argv for sandbox-exec", () => {
    expect(seatbeltArgv(["/bin/echo", "hi"], "(version 1)")).toEqual([
      "/usr/bin/sandbox-exec",
      "-p",
      "(version 1)",
      "/bin/echo",
      "hi",
    ]);
  });
});

describe("guardrailConfigFromEnv", () => {
  it("takes paths and ports from the running configuration", () => {
    const config = guardrailConfigFromEnv(
      {
        ARDURBOT_ENV_FILE: "/srv/repo/.env",
        DATA_DIR: "./data",
        ARDURBOT_GUARD_PATHS: ["/u/data/secrets.env", "/u/data/postgres"].join(path.delimiter),
        DATABASE_URL: "postgres://ardurbot:***@127.0.0.1:5433/ardurbot",
        REALTIME_DATABASE_URL: "postgres://ardurbot:***@db.internal:5432/ardurbot",
        API_PORT: "3100",
        API_URL: "http://127.0.0.1:3100",
        SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091",
      },
      "/srv/repo",
    );
    expect(config.paths).toContain("/srv/repo/.env");
    expect(config.paths).toContain("/u/data/secrets.env");
    expect(config.paths).toContain("/u/data/postgres");
    for (const child of GUARDED_DATA_DIR_CHILDREN)
      expect(config.paths).toContain(path.join("/srv/repo/data", child));
    // The bots' own homes stay reachable.
    expect(config.paths).not.toContain(path.join("/srv/repo/data", "desktop-computers"));
    // Only loopback services are denied; the remote database URL contributes nothing.
    expect(config.ports).toEqual([5433, 3100, 7091]);
    // The default Docker socket is always denied, even with no engine configuration.
    expect(config.sockets).toContain("/var/run/docker.sock");
  });

  it("ignores unset, relative, and malformed values", () => {
    const config = guardrailConfigFromEnv(
      {
        DATA_DIR: "",
        ARDURBOT_ENV_FILE: "relative/.env",
        ARDURBOT_GUARD_PATHS: ["", "also/relative"].join(path.delimiter),
        DATABASE_URL: "not a url",
        API_PORT: "not a port",
      },
      "/srv/repo",
    );
    expect(config.paths).toEqual(
      GUARDED_DATA_DIR_CHILDREN.map((child) => path.join("/srv/repo/data", child)),
    );
    expect(config.ports).toEqual([]);
  });

  it("denies the database files of a source checkout's cluster, not the open children", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guard-cluster-"));
    cleanup.push(root);
    const data = path.join(root, "data");
    await mkdir(path.join(data, "base"), { recursive: true });
    await mkdir(path.join(data, "pg_wal"));
    await mkdir(path.join(data, "desktop-computers"));
    await mkdir(path.join(data, "board"));
    await writeFile(path.join(data, "PG_VERSION"), "16\n");
    await writeFile(path.join(data, "credentials.json"), "{}");
    const config = guardrailConfigFromEnv({ DATA_DIR: data, HOME: path.join(root, "no-home") });
    // The cluster entries and the dev credentials are derived from the running stack's data.
    expect(config.paths).toContain(path.join(data, "PG_VERSION"));
    expect(config.paths).toContain(path.join(data, "credentials.json"));
    expect(config.paths).toContain(path.join(data, "base"));
    expect(config.paths).toContain(path.join(data, "pg_wal"));
    // The bots' homes and the board databases stay writable.
    expect(config.paths).not.toContain(path.join(data, "desktop-computers"));
    expect(config.paths).not.toContain(path.join(data, "board"));
  });

  it("adds no database files for a data directory without a cluster", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guard-plain-"));
    cleanup.push(root);
    const data = path.join(root, "data");
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, "credentials.json"), "{}");
    const config = guardrailConfigFromEnv({ DATA_DIR: data, HOME: path.join(root, "no-home") });
    expect(config.paths).toEqual(GUARDED_DATA_DIR_CHILDREN.map((child) => path.join(data, child)));
  });
});

describe("containerEngineGuard", () => {
  it("lists every known engine socket under the configured home", () => {
    const { sockets } = containerEngineGuard({ HOME: "/fixture/home" });
    expect(sockets).toContain("/var/run/docker.sock");
    expect(sockets).toContain("/fixture/home/.docker/run/docker.sock");
    expect(sockets).toContain("/fixture/home/.docker/desktop/docker.sock");
    expect(sockets).toContain("/fixture/home/.orbstack/run/docker.sock");
    expect(sockets).toContain("/fixture/home/.colima/default/docker.sock");
    expect(sockets).toContain("/fixture/home/.local/share/containers/podman/machine/podman.sock");
  });

  it("discovers Colima profiles and Podman machine providers from disk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guard-engines-"));
    cleanup.push(root);
    const home = path.join(root, "home");
    await mkdir(path.join(home, ".colima", "default"), { recursive: true });
    await mkdir(path.join(home, ".colima", "work"));
    await writeFile(path.join(home, ".colima", "socket.log"), "not a profile");
    await mkdir(path.join(home, "xdg", "containers", "podman", "machine", "applehv"), {
      recursive: true,
    });
    await mkdir(path.join(home, "xdg", "containers", "podman", "machine", "qemu"));
    const { sockets } = containerEngineGuard({
      HOME: home,
      XDG_DATA_HOME: path.join(home, "xdg"),
    });
    expect(sockets).toContain(path.join(home, ".colima", "work", "docker.sock"));
    expect(sockets).not.toContain(path.join(home, ".colima", "socket.log", "docker.sock"));
    expect(sockets).toContain(
      path.join(home, "xdg", "containers", "podman", "machine", "applehv", "podman.sock"),
    );
    expect(sockets).toContain(
      path.join(home, "xdg", "containers", "podman", "machine", "qemu", "podman.sock"),
    );
  });

  it("follows DOCKER_HOST and CONTAINER_HOST, unix and loopback tcp only", () => {
    const { sockets, ports } = containerEngineGuard({
      HOME: "/fixture/home",
      DOCKER_HOST: "unix:///custom/run/docker.sock",
      CONTAINER_HOST: "tcp://127.0.0.1:2375",
    });
    expect(sockets).toContain("/custom/run/docker.sock");
    expect(ports).toEqual([2375]);
    const remote = containerEngineGuard({
      HOME: "/fixture/home",
      DOCKER_HOST: "tcp://192.0.2.10:2375",
      CONTAINER_HOST: "unix://relative/docker.sock",
    });
    expect(remote.sockets).not.toContain("relative/docker.sock");
    expect(remote.ports).toEqual([]);
  });

  it("uses XDG_RUNTIME_DIR for the rootless Podman socket when set", () => {
    const { sockets } = containerEngineGuard({
      HOME: "/fixture/home",
      XDG_RUNTIME_DIR: "/fixture/xdg-runtime",
    });
    expect(sockets).toContain("/fixture/xdg-runtime/podman/podman.sock");
  });
});

describe("loopbackPortOf", () => {
  it("reads only loopback ports, with scheme defaults", () => {
    expect(loopbackPortOf("postgres://u:***@127.0.0.1:5433/db")).toBe(5433);
    expect(loopbackPortOf("postgres://u:***@localhost/db")).toBe(5432);
    expect(loopbackPortOf("postgres://u:***@[::1]:5433/db")).toBe(5433);
    expect(loopbackPortOf("http://127.0.0.1:3100")).toBe(3100);
    expect(loopbackPortOf("postgres://u:p://db.internal:5432/db")).toBeUndefined();
    expect(loopbackPortOf("postgres://u:***@192.0.2.10:5432/db")).toBeUndefined();
    expect(loopbackPortOf(undefined)).toBeUndefined();
    expect(loopbackPortOf("")).toBeUndefined();
  });
});

describe("resolveGuardrailPaths", () => {
  it("denies both the spelled and the resolved form of a symlinked path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guard-paths-"));
    cleanup.push(root);
    const real = path.join(root, "real");
    await mkdir(real);
    await writeFile(path.join(real, "secrets.env"), "fake");
    const link = path.join(root, "linked");
    await symlink(real, link);
    const missing = path.join(root, "not-created-yet");
    const resolved = await resolveGuardrailPaths([link, missing]);
    expect(resolved).toContain(link);
    expect(resolved).toContain(await realpath(real));
    expect(resolved).toContain(missing);
    expect(resolveGuardrailPathsSync([link])).toEqual(await resolveGuardrailPaths([link]));
  });

  it("denies a missing path in the spelling its nearest existing ancestor resolves to", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guard-missing-"));
    cleanup.push(root);
    const spelled = path.join(root, "linked-parent");
    const target = path.join(root, "real-parent");
    await mkdir(target);
    await symlink(target, spelled);
    const missing = path.join(spelled, "future", "secrets.env");
    const resolved = await resolveGuardrailPaths([missing]);
    expect(resolved).toContain(missing);
    expect(resolved).toContain(path.join(await realpath(target), "future", "secrets.env"));
    expect(resolveGuardrailPathsSync([missing])).toEqual(resolved);
  });
});

describe("isGuardedPath", () => {
  const paths = ["/srv/data/secrets", "/srv/stack/.env"];
  it("matches the path itself and its children, not its siblings", () => {
    expect(isGuardedPath(paths, "/srv/data/secrets", "linux")).toBe(true);
    expect(isGuardedPath(paths, "/srv/data/secrets/keys.txt", "linux")).toBe(true);
    expect(isGuardedPath(paths, "/srv/data/secrets-extra", "linux")).toBe(false);
    expect(isGuardedPath(paths, "/srv/other", "linux")).toBe(false);
  });
  it("folds case on macOS and Windows but not Linux", () => {
    expect(isGuardedPath(paths, "/SRV/DATA/SECRETS", "darwin")).toBe(true);
    expect(isGuardedPath(paths, "/SRV/DATA/SECRETS", "win32")).toBe(true);
    expect(isGuardedPath(paths, "/SRV/DATA/SECRETS", "linux")).toBe(false);
  });
});

/**
 * The profile text tests above pin the generated string; these run that string through the
 * real `/usr/bin/sandbox-exec` against temporary files, a temporary unix socket and a local
 * port, so a rule shape the kernel ignores cannot stay green. macOS-only: the wrapper does
 * not exist elsewhere.
 */
describe.skipIf(process.platform !== "darwin")("seatbelt profile under real sandbox-exec", () => {
  const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

  function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(argv[0]!, argv.slice(1), { timeout: 15_000 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      });
    });
  }

  function sandboxed(profile: string, argv: string[]) {
    return run([SANDBOX_EXEC, "-p", profile, ...argv]);
  }

  /** A client one-liner run under the profile; prints *_OK on connect, exits 1 on error. */
  function connectArgv(kind: "tcp" | "unix", target: string | number) {
    const script =
      kind === "tcp"
        ? `const s=require("node:net").connect({host:"127.0.0.1",port:${target}});` +
          `s.on("connect",()=>{console.log("TCP_OK");process.exit(0)});` +
          `s.on("error",(e)=>{console.error("TCP_FAIL",e.code);process.exit(1)});`
        : `const s=require("node:net").connect({path:${JSON.stringify(target)}});` +
          `s.on("connect",()=>{console.log("UNIX_OK");process.exit(0)});` +
          `s.on("error",(e)=>{console.error("UNIX_FAIL",e.code);process.exit(1)});`;
    return [process.execPath, "-e", script];
  }

  async function listenTcp(): Promise<number> {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return address.port;
  }

  async function listenUnix(socketPath: string): Promise<void> {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
  }

  it("fails reading a denied file while an allowed temporary file still reads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guard-exec-file-"));
    cleanup.push(root);
    const deniedDir = path.join(root, "control-plane");
    await mkdir(deniedDir);
    await writeFile(path.join(deniedDir, "secrets.env"), "FAKE=1\n");
    const allowed = path.join(root, "notes.txt");
    await writeFile(allowed, "ordinary work\n");
    const profile = seatbeltProfile({
      paths: await resolveGuardrailPaths([deniedDir]),
      ports: [],
      sockets: [],
    });
    const denied = await sandboxed(profile, ["/bin/cat", path.join(deniedDir, "secrets.env")]);
    expect(denied.code).not.toBe(0);
    expect(denied.stdout).not.toContain("FAKE=1");
    expect(denied.stderr).toContain("Operation not permitted");
    const allowedRun = await sandboxed(profile, ["/bin/cat", allowed]);
    expect(allowedRun.code).toBe(0);
    expect(allowedRun.stdout).toBe("ordinary work\n");
  });

  it("fails connecting to a denied loopback port while another local port still connects", async () => {
    const deniedPort = await listenTcp();
    const allowedPort = await listenTcp();
    const profile = seatbeltProfile({ paths: [], ports: [deniedPort], sockets: [] });
    const denied = await sandboxed(profile, connectArgv("tcp", deniedPort));
    expect(denied.code).not.toBe(0);
    expect(denied.stdout).not.toContain("TCP_OK");
    const allowed = await sandboxed(profile, connectArgv("tcp", allowedPort));
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toContain("TCP_OK");
  });

  it("fails connecting to a denied unix socket while another socket still connects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guard-exec-sock-"));
    cleanup.push(root);
    const deniedSocket = path.join(root, "engine.sock");
    const allowedSocket = path.join(root, "other.sock");
    await listenUnix(deniedSocket);
    await listenUnix(allowedSocket);
    // The production flow resolves the spelled temp path to the kernel's spelling.
    const profile = seatbeltProfile({
      paths: [],
      ports: [],
      sockets: await resolveGuardrailPaths([deniedSocket]),
    });
    const denied = await sandboxed(profile, connectArgv("unix", deniedSocket));
    expect(denied.code).not.toBe(0);
    expect(denied.stdout).not.toContain("UNIX_OK");
    const allowed = await sandboxed(profile, connectArgv("unix", allowedSocket));
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toContain("UNIX_OK");
  });

  it("fails closed on an invalid profile: the command never runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guard-exec-invalid-"));
    cleanup.push(root);
    const marker = path.join(root, "marker");
    const result = await sandboxed("(version 1)(this is not a rule", ["/usr/bin/touch", marker]);
    expect(result.code).not.toBe(0);
    await expect(realpath(marker)).rejects.toThrow();
  });
});
