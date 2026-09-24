import { describe, expect, it, vi } from "vitest";
import {
  memoryComposeOverride,
  memoryFolder,
  memoryFolderBridgeAllowed,
  registerMemoryFolder,
} from "./memory-folders.js";

function fixture() {
  const files = new Map<string, string>();
  const deps = {
    stackDir: "/fixture/stack",
    pick: vi.fn(async () => "/fixture/empty-folder"),
    validate: vi.fn(async () => undefined),
    read: async (file: string) => files.get(file) ?? null,
    write: async (file: string, text: string) => {
      files.set(file, text);
    },
    apply: vi.fn(async () => undefined),
  };
  return { deps, files };
}
describe("desktop memory folder registration", () => {
  it("only exposes local-folder access to the managed local main frame", () => {
    const input = {
      mainWindow: true,
      mainFrame: true,
      mode: "new",
      frameUrl: "http://127.0.0.1:5173/settings",
      localUrl: "http://127.0.0.1:5173",
    };
    expect(memoryFolderBridgeAllowed(input)).toBe(true);
    for (const change of [
      { mainFrame: false },
      { mainWindow: false },
      { mode: "existing" },
      { frameUrl: "https://remote.example.test/settings" },
      { frameUrl: "http://127.0.0.1:5174/settings" },
    ])
      expect(memoryFolderBridgeAllowed({ ...input, ...change })).toBe(false);
  });
  it("mounts only the selected folders into api and worker, using stable independent targets", async () => {
    const f = fixture();
    const first = await registerMemoryFolder("space-a", f.deps);
    f.deps.pick.mockResolvedValue("/fixture/second-folder");
    const second = await registerMemoryFolder("space-a", f.deps);
    expect(first?.path).not.toBe(second?.path);
    const override = JSON.parse(f.files.get("/fixture/stack/docker-compose.memory.json")!);
    expect(Object.keys(override.services)).toEqual(["api", "worker"]);
    expect(override.services.api.volumes).toHaveLength(3);
    expect(override.services.worker.volumes).toEqual(override.services.api.volumes);
    expect(override.services.api.volumes[0]).toMatchObject({
      type: "bind",
      source: "/fixture/empty-folder",
      bind: { create_host_path: false },
    });
    expect(override.services.api.volumes[2]).toMatchObject({
      source: "/fixture/stack/memory-git",
      target: "/data/memory-git",
    });
    expect(f.deps.apply).toHaveBeenCalledTimes(2);
  });
  it("does not mount anything on cancellation, invalid identity, validation or stack failure", async () => {
    const f = fixture();
    await expect(registerMemoryFolder("../../space", f.deps)).rejects.toThrow();
    expect(f.deps.pick).not.toHaveBeenCalled();
    f.deps.validate.mockRejectedValueOnce(new Error("Symlink"));
    await expect(registerMemoryFolder("space-a", f.deps)).rejects.toThrow();
    expect(f.files.size).toBe(0);
    f.deps.apply.mockRejectedValueOnce(new Error("Stack offline"));
    await expect(registerMemoryFolder("space-a", f.deps)).rejects.toThrow("Could not attach");
    expect(f.files.has("/fixture/stack/memory-folders.json")).toBe(false);
    expect(
      JSON.parse(f.files.get("/fixture/stack/docker-compose.memory.json")!).services.api.volumes,
    ).toEqual([expect.objectContaining({ target: "/data/memory-git" })]);
    const result = await registerMemoryFolder("space-a", { ...f.deps, pick: async () => null });
    expect(result).toBeNull();
  });
  it("uses long Compose mount syntax for Windows paths and escapes interpolation", () => {
    const folder = memoryFolder("space-a", "C:\\fixture\\vault$cash");
    const override = JSON.parse(memoryComposeOverride([folder]));
    expect(override.services.api.volumes[0].source).toBe("C:\\fixture\\vault$$cash");
    expect(override.services.api.volumes[0].target).toMatch(
      /^\/memory-folders\/space-a\/[a-f0-9]{24}$/,
    );
  });
});
