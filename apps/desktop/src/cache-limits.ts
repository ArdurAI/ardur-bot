/**
 * Chromium's disk cache is uncapped by default. `--disk-cache-size` (bytes) must be set
 * before `app.ready`; Electron ignores it afterwards.
 * https://www.electronjs.org/docs/latest/api/command-line-switches#--disk-cache-sizesize
 */
export const DISK_CACHE_LIMIT_BYTES = 64 * 1024 * 1024;

export interface CommandLineLike {
  appendSwitch(theSwitch: string, value?: string): void;
}

/** Call before `app.whenReady()`; the switch has no effect once Chromium has started. */
export function capDiskCacheSize(commandLine: CommandLineLike): void {
  commandLine.appendSwitch("disk-cache-size", String(DISK_CACHE_LIMIT_BYTES));
}

/**
 * The narrow slice of `session.Session` these helpers need.
 * https://www.electronjs.org/docs/latest/api/session
 */
export interface CacheSession {
  getCacheSize(): Promise<number>;
  clearCodeCaches(options: { urls?: string[] }): Promise<void>;
  clearStorageData(options?: { origin?: string; storages?: string[] }): Promise<void>;
  clearData(options?: { dataTypes?: string[] }): Promise<void>;
}

/**
 * Runs once at launch. A session that grew past the disk-cache cap before this session
 * ever ran with it (an upgrade, or the cap being lowered) can still carry a large code
 * cache and worker/cache storage forward, since `--disk-cache-size` only bounds the HTTP
 * cache. Cookies and page storage (`localstorage`, `indexdb`) are never touched here, so
 * a signed-in session survives.
 */
export async function clearOversizedCache(target: CacheSession): Promise<boolean> {
  const size = await target.getCacheSize();
  if (size <= DISK_CACHE_LIMIT_BYTES) return false;
  await target.clearCodeCaches({});
  await target.clearStorageData({ storages: ["shadercache", "serviceworkers", "cachestorage"] });
  return true;
}

/**
 * Settings → Storage "Clear caches": HTTP cache, code cache, cache storage and service
 * workers only. Never cookies or local/indexed storage, so sign-in survives.
 */
export async function clearAppCaches(target: CacheSession): Promise<void> {
  await target.clearData({ dataTypes: ["cache", "serviceWorkers"] });
  await target.clearCodeCaches({});
}
