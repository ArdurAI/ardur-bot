import { describe, expect, it, vi } from "vitest";
import {
  capDiskCacheSize,
  clearAppCaches,
  clearOversizedCache,
  DISK_CACHE_LIMIT_BYTES,
} from "./cache-limits.js";

function fakeSession(cacheSize: number) {
  return {
    getCacheSize: vi.fn(async () => cacheSize),
    clearCodeCaches: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
    clearData: vi.fn(async () => undefined),
  };
}

describe("capDiskCacheSize", () => {
  it("appends the disk-cache-size switch at 64 MiB", () => {
    const commandLine = { appendSwitch: vi.fn() };
    capDiskCacheSize(commandLine);
    expect(DISK_CACHE_LIMIT_BYTES).toBe(67_108_864);
    expect(commandLine.appendSwitch).toHaveBeenCalledExactlyOnceWith("disk-cache-size", "67108864");
  });
});

describe("clearOversizedCache", () => {
  it("does nothing when the cache is at or under the cap", async () => {
    const session = fakeSession(DISK_CACHE_LIMIT_BYTES);
    expect(await clearOversizedCache(session)).toBe(false);
    expect(session.clearCodeCaches).not.toHaveBeenCalled();
    expect(session.clearStorageData).not.toHaveBeenCalled();
  });

  it("clears code caches and worker/cache storage, never cookies or local storage, when oversized", async () => {
    const session = fakeSession(DISK_CACHE_LIMIT_BYTES + 1);
    expect(await clearOversizedCache(session)).toBe(true);
    expect(session.clearCodeCaches).toHaveBeenCalledExactlyOnceWith({});
    expect(session.clearStorageData).toHaveBeenCalledExactlyOnceWith({
      storages: ["shadercache", "serviceworkers", "cachestorage"],
    });
    const storagesArg = session.clearStorageData.mock.calls[0]![0]!.storages!;
    expect(storagesArg).not.toContain("cookies");
    expect(storagesArg).not.toContain("localstorage");
    expect(storagesArg).not.toContain("indexdb");
  });
});

describe("clearAppCaches", () => {
  it("clears only cache and service-worker data, never cookies or local storage", async () => {
    const session = fakeSession(0);
    await clearAppCaches(session);
    expect(session.clearData).toHaveBeenCalledExactlyOnceWith({
      dataTypes: ["cache", "serviceWorkers"],
    });
    expect(session.clearCodeCaches).toHaveBeenCalledExactlyOnceWith({});
    const dataTypesArg = session.clearData.mock.calls[0]![0]!.dataTypes!;
    expect(dataTypesArg).not.toContain("cookies");
    expect(dataTypesArg).not.toContain("localStorage");
    expect(dataTypesArg).not.toContain("indexedDB");
  });
});
