import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnoseNativeIsolation } from "./native-diagnostics.js";

const doubles = vi.hoisted(() => ({
  exec: vi.fn(),
  realpath: vi.fn(),
  readFile: vi.fn(async () => Buffer.from("synthetic-interpreter")),
}));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: doubles.exec,
  }),
  execFileSync: vi.fn(() => {
    throw new Error("Git and host processes are not part of this regression");
  }),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  realpath: doubles.realpath,
  readFile: doubles.readFile,
  writeFile: vi.fn(),
  symlink: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("node:http", () => ({
  createServer: () => ({
    listen: (_port: number, _host: string, ready: () => void) => ready(),
    address: () => ({ port: 12345 }),
    close: (closed: () => void) => closed(),
  }),
}));
vi.mock("./isolation.js", () => ({
  proveNativeIsolation: async () => ({ result: { passed: false } }),
  nativeProfile: () => "(version 1)(deny default)",
  prepareEnvironment: async () => ({}),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("native diagnostic privacy (scripted on every platform)", () => {
  it.each(["/Volumes/Synthetic Runtime/python/3.13", "/opt/homebrew/Cellar/python/3.13"])(
    "redacts an external interpreter and sibling library prefix %s from retained probes",
    async (prefix) => {
      vi.stubGlobal("process", { ...process, platform: "darwin" });
      const interpreter = `${prefix}/bin/python3`;
      doubles.realpath.mockResolvedValue(interpreter);
      const message = `startup failed: '${interpreter}' loading '${prefix}/lib/libpython.dylib'`;
      doubles.exec.mockRejectedValue({ code: 1, signal: null, stdout: message, stderr: message });
      const result = await diagnoseNativeIsolation({
        trial: { root: "/trial", workspace: "/trial/workspace", state: "/trial/state", owner: "a" },
        outside: {
          root: "/outside",
          workspace: "/outside/workspace",
          state: "/outside/state",
          owner: "b",
        },
        source: "/synthetic-install",
        executable: "/synthetic-install/bin/hermes",
      });
      expect(doubles.realpath).toHaveBeenCalledWith("/synthetic-install/bin/python3");
      expect(doubles.readFile).toHaveBeenCalledWith(interpreter);
      expect(
        result.probes.filter(
          (probe) => probe.name.includes("python") || probe.name.includes("resource"),
        ),
      ).toHaveLength(2);
      expect(result.runtimeCanariesPassed).toBe(false);
      expect(result.interpreterHash).toMatch(/^[a-f0-9]{64}$/);
      for (const probe of result.probes) {
        expect(probe.exitCode).toBe(1);
        expect(probe.stdout).toContain("startup failed");
        expect(probe.stderr).toContain("loading");
        expect(JSON.stringify(probe)).not.toContain(prefix);
      }
    },
  );
});
