import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("seatbeltProfile", () => {
  it("allows normal work and denies exactly the given paths and ports", () => {
    const profile = seatbeltProfile({
      paths: ["/srv/stack/.env", "/srv/data/secrets"],
      ports: [7091, 5433],
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

  it("escapes quotes and backslashes in paths", () => {
    const profile = seatbeltProfile({
      paths: ['/data/odd "quoted" name', "/data/back\\slash"],
      ports: [],
    });
    expect(profile).toContain('(subpath "/data/odd \\"quoted\\" name")');
    expect(profile).toContain('(subpath "/data/back\\\\slash")');
  });

  it("fails closed on paths and ports it cannot express", () => {
    expect(() => seatbeltProfile({ paths: ["relative/.env"], ports: [] })).toThrow(
      "Invalid host guardrail path.",
    );
    expect(() => seatbeltProfile({ paths: ["/data/bad\nname"], ports: [] })).toThrow(
      "Invalid host guardrail path.",
    );
    expect(() => seatbeltProfile({ paths: [], ports: [0] })).toThrow(
      "Invalid host guardrail port.",
    );
    expect(() => seatbeltProfile({ paths: [], ports: [65536] })).toThrow(
      "Invalid host guardrail port.",
    );
    expect(() => seatbeltProfile({ paths: [], ports: [5433.5] })).toThrow(
      "Invalid host guardrail port.",
    );
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
        DATABASE_URL: "postgres://ardurbot:pw@127.0.0.1:5433/ardurbot",
        REALTIME_DATABASE_URL: "postgres://ardurbot:pw@db.internal:5432/ardurbot",
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
});

describe("loopbackPortOf", () => {
  it("reads only loopback ports, with scheme defaults", () => {
    expect(loopbackPortOf("postgres://u:p@127.0.0.1:5433/db")).toBe(5433);
    expect(loopbackPortOf("postgres://u:p@localhost/db")).toBe(5432);
    expect(loopbackPortOf("postgres://u:p@[::1]:5433/db")).toBe(5433);
    expect(loopbackPortOf("http://127.0.0.1:3100")).toBe(3100);
    expect(loopbackPortOf("postgres://u:p://db.internal:5432/db")).toBeUndefined();
    expect(loopbackPortOf("postgres://u:p@192.0.2.10:5432/db")).toBeUndefined();
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
