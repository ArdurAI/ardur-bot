import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostServiceStore,
  HostServiceSupervisor,
  hostServiceEnvironment,
  hostServiceIdentity,
  hostServiceLaunch,
  hostStorageAvailable,
} from "./host-service.js";

const config = {
  apiUrl: "http://127.0.0.1:3100",
  token: "fixture-pairing-value",
  root: "/fixture/workspaces",
  hostRoots: ["/fixture/projects"],
};
afterEach(() => vi.useRealTimers());

describe("desktop host service", () => {
  it("identifies an existing pairing without exposing its token or host verifier", () => {
    const registrationId = hostServiceIdentity({ ...config, token: "fixture-pairing-token" });
    expect(registrationId).toBe("abec6392afbdae15f7d66b9ef0b06fb1b36fff3dcd9d8ae47ddc5c4dabcfd2f3");
    expect(registrationId).not.toBe(
      "88c4c7666e266dc304941faed55a473c5103f9226538773a685b514f62e997e6",
    );
    expect(hostServiceIdentity({ ...config, token: "another-fixture-pairing" })).not.toBe(
      registrationId,
    );
  });
  it.each(["win32", "linux", "darwin"] as const)(
    "launches compiled JavaScript using Electron Node mode on %s",
    (platform) => {
      const launch = hostServiceLaunch({
        packaged: true,
        execPath: "/app/electron",
        resourcesPath: "/app/resources",
        appPath: "/app",
        platform,
      });
      expect(launch.command).toBe("/app/electron");
      expect(launch.args).toEqual(["/app/resources/host-service/host-service.cjs"]);
      expect(launch.options).toMatchObject({
        shell: false,
        windowsHide: true,
        env: { ELECTRON_RUN_AS_NODE: "1" },
      });
      expect(JSON.stringify(launch)).not.toContain(config.token);
      const env = hostServiceEnvironment(
        {
          PATH: "/usr/bin",
          NODE_OPTIONS: "injection",
          ANTHROPIC_API_KEY: "secret",
          HOST_TOKEN: "secret",
        },
        platform,
      );
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.HOST_TOKEN).toBeUndefined();
      if (platform === "win32") expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBe("1");
    },
  );
  it("restarts with bounded backoff, sends credentials only over IPC, and stops on explicit quit", async () => {
    vi.useFakeTimers();
    const children: ChildProcess[] = [];
    const spawn = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        connected: true,
        send: vi.fn(),
        kill: vi.fn(),
      }) as unknown as ChildProcess;
      children.push(child);
      return child;
    });
    const changed = vi.fn();
    const supervisor = new HostServiceSupervisor(
      hostServiceLaunch({
        packaged: true,
        execPath: "/app/electron",
        resourcesPath: "/app/resources",
        appPath: "/app",
      }),
      changed,
      spawn,
    );
    supervisor.start(config);
    children[0]!.emit("spawn");
    expect(children[0]!.send).toHaveBeenCalledWith(config, expect.any(Function));
    expect(JSON.stringify(spawn.mock.calls)).not.toContain(config.token);
    // Reopening the same application window must not abort an active host turn.
    supervisor.start({ ...config, hostRoots: [...config.hostRoots] });
    expect(children).toHaveLength(1);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    children[0]!.emit("message", { type: "host-state", connected: true });
    expect(changed).toHaveBeenLastCalledWith(true);
    children[0]!.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(499);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);
    children[1]!.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(999);
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(3);
    supervisor.stop();
    expect(children[2]!.send).toHaveBeenCalledWith({ type: "stop" }, expect.any(Function));
    children[2]!.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(3);
  });
  it("refuses insecure Linux storage and persists only encrypted bytes", async () => {
    const unavailable = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text",
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    };
    expect(hostStorageAvailable(unavailable, "linux")).toBe(false);
    expect(
      hostStorageAvailable(
        { ...unavailable, getSelectedStorageBackend: () => "gnome_libsecret" },
        "linux",
      ),
    ).toBe(true);
    const directory = await mkdtemp(path.join(tmpdir(), "host-store-"));
    try {
      const encrypted = Buffer.from("opaque-os-encrypted-data");
      const storage = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "gnome_libsecret",
        encryptString: vi.fn(() => encrypted),
        decryptString: vi.fn(() => JSON.stringify(config)),
      };
      const store = new HostServiceStore(directory, storage);
      await store.write(config);
      expect(await readFile(path.join(directory, "host-service.enc"), "utf8")).toEqual(
        encrypted.toString("base64"),
      );
      expect(await store.read()).toEqual(config);
      await store.clear();
      expect(await store.read()).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("uses absolute taskkill without a shell on Windows", async () => {
  const { stopHostProcess } = await import("./host-service.js");
  vi.stubEnv("SystemRoot", "C:\\Windows");
  const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const start = vi.fn(() => killer) as unknown as typeof import("node:child_process").spawn;
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    kill: vi.fn(),
  }) as unknown as ChildProcess;
  try {
    stopHostProcess(child, "win32", start);
    expect(start).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", "1234", "/t", "/f"],
      { shell: false, windowsHide: true, stdio: "ignore" },
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
