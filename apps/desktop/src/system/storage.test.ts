import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyStorageDirectory,
  STORAGE_FAILED,
  STORAGE_RECOVERY_FAILED,
  StorageMove,
  validateStorageDestination,
} from "./storage.js";

function fixture() {
  const backend = {
    current: () => "/fixture/original",
    recommended: () => "/fixture/default",
    pick: vi.fn(async () => "/fixture/new" as string | null),
    confirm: vi.fn(async () => true),
    validate: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    copy: vi.fn(async () => undefined),
    activate: vi.fn(async (_directory: string) => undefined),
    start: vi.fn(async () => undefined),
    persist: vi.fn(async (_directory: string) => undefined),
    discard: vi.fn(async () => undefined),
  };
  return { backend, move: new StorageMove(backend) };
}

describe("storage transaction", () => {
  it("does nothing when the picker or confirmation is cancelled", async () => {
    const f = fixture();
    f.backend.pick.mockResolvedValueOnce(null);
    await f.move.move(false);
    f.backend.confirm.mockResolvedValueOnce(false);
    await f.move.move(false);
    expect(f.backend.stop).not.toHaveBeenCalled();
    expect(f.backend.copy).not.toHaveBeenCalled();
  });
  it("confirms, stops, copies, verifies restart, then persists", async () => {
    const f = fixture();
    await f.move.move(false);
    expect(f.backend.confirm).toHaveBeenCalledWith("/fixture/new");
    expect(f.backend.copy).toHaveBeenCalledWith("/fixture/original", "/fixture/new");
    const steps = [
      f.backend.confirm,
      f.backend.stop,
      f.backend.copy,
      f.backend.activate,
      f.backend.start,
      f.backend.persist,
    ].map((step) => step.mock.invocationCallOrder[0]!);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(f.backend.discard).not.toHaveBeenCalled();
    expect(f.move.progress).toBeNull();
  });
  it("uses the recommended path with the same confirmation", async () => {
    const f = fixture();
    await f.move.move(true);
    expect(f.backend.pick).not.toHaveBeenCalled();
    expect(f.backend.confirm).toHaveBeenCalledWith("/fixture/default");
  });
  it.each(["copy", "activate", "start", "persist"] as const)(
    "rolls back a %s failure",
    async (step) => {
      const f = fixture();
      f.backend[step].mockRejectedValueOnce(new Error("disk failure"));
      await expect(f.move.move(false)).rejects.toThrow(STORAGE_FAILED);
      expect(f.backend.activate).toHaveBeenLastCalledWith("/fixture/original");
      expect(f.backend.persist).toHaveBeenLastCalledWith("/fixture/original");
      expect(f.backend.discard).not.toHaveBeenCalled();
      expect(f.move.progress).toBeNull();
    },
  );
  it("retains both copies if rollback cannot restart the original", async () => {
    const f = fixture();
    f.backend.start.mockRejectedValue(new Error("engine failed"));
    await expect(f.move.move(false)).rejects.toThrow(STORAGE_RECOVERY_FAILED);
    expect(f.backend.discard).not.toHaveBeenCalled();
  });
  it("serializes the picker and exposes progress during the copy", async () => {
    const f = fixture();
    let finish!: () => void;
    f.backend.copy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const running = f.move.move(false);
    await vi.waitFor(() => expect(f.move.progress).toBe("Moving storage…"));
    await expect(f.move.move(true)).rejects.toThrow("already in progress");
    finish();
    await running;
  });
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
it("rejects nested, existing and symlink destinations and copies without following data symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "system-storage-"));
  directories.push(root);
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "artifact"), "retained content");
  await symlink(source, path.join(root, "alias"));
  await expect(
    validateStorageDestination(source, path.join(root, "alias", "nested")),
  ).rejects.toThrow("outside");
  await expect(validateStorageDestination(source, source)).rejects.toThrow();
  await expect(validateStorageDestination(source, root)).rejects.toThrow();
  await expect(validateStorageDestination(source, path.join(root, "alias"))).rejects.toThrow(
    "new storage folder",
  );
  const destination = path.join(root, "new");
  await validateStorageDestination(source, destination);
  await copyStorageDirectory(source, destination);
  expect(await readFile(path.join(destination, "artifact"), "utf8")).toBe("retained content");
  expect(await readFile(path.join(source, "artifact"), "utf8")).toBe("retained content");
});
