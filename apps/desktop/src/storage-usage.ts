import path from "node:path";
import { dockerSpawnEnv, type RunDocker, resolveDockerBinary } from "./docker-cli.js";
import { dockerVolumeSizes } from "./docker-volumes.js";
import { STACK_PROJECT_NAME, stackDir } from "./local-stack.js";
import { directorySize } from "./size-walk.js";
import type { DesktopStorageRow } from "./storage-report.js";

const DOCKER_VOLUME_NAMES = [
  `${STACK_PROJECT_NAME}_pgdata`,
  `${STACK_PROJECT_NAME}_appdata`,
] as const;

export interface StorageUsageDeps {
  userDataDir: string;
  platform: string;
  env: NodeJS.ProcessEnv;
  exists: (file: string) => boolean;
  run: RunDocker;
  /** The app session whose HTTP cache and code cache make up the "App cache" row. */
  cacheSession: {
    getCacheSize(): Promise<number>;
    getStoragePath(): string | null;
  };
}

async function row(id: DesktopStorageRow["id"], paths: string[]): Promise<DesktopStorageRow> {
  const size = await directorySize(paths);
  return { id, paths, bytes: size.bytes, approximate: size.approximate };
}

/** Builds the rows Settings → Storage shows, each already knowing where it lives on this machine. */
export async function collectStorageUsage(deps: StorageUsageDeps): Promise<DesktopStorageRow[]> {
  const dataDir = path.join(deps.userDataDir, "data");
  const rows: DesktopStorageRow[] = [];

  rows.push(await row("database", [path.join(deps.userDataDir, "postgres")]));
  rows.push(
    await row("computerHomes", [
      path.join(dataDir, "homes"),
      path.join(dataDir, "desktop-computers"),
    ]),
  );
  rows.push(await row("checkpoints", [path.join(dataDir, "home-revisions")]));
  rows.push(await row("artifacts", [path.join(dataDir, "artifacts")]));
  rows.push(await row("boards", [path.join(dataDir, "board")]));

  const sessionsPath = path.join(dataDir, "pi-sessions");
  if (deps.exists(sessionsPath)) rows.push(await row("sessions", [sessionsPath]));

  const cacheBytes = await deps.cacheSession.getCacheSize();
  const storagePath = deps.cacheSession.getStoragePath() ?? deps.userDataDir;
  const codeCachePath = path.join(storagePath, "Code Cache");
  const codeCache = await directorySize([codeCachePath]);
  rows.push({
    id: "appCache",
    paths: [...new Set([storagePath, codeCachePath])],
    bytes: cacheBytes + codeCache.bytes,
    approximate: codeCache.approximate,
  });

  const stackPath = stackDir(deps.userDataDir);
  if (deps.exists(stackPath)) {
    const stackSize = await directorySize([stackPath]);
    const binary = resolveDockerBinary(deps.platform, deps.env, deps.exists);
    let dockerUnavailable = true;
    let volumeBytes = 0;
    if (binary !== null) {
      const sizes = await dockerVolumeSizes(
        binary,
        dockerSpawnEnv(deps.platform, deps.env, binary),
        stackPath,
        deps.run,
        [...DOCKER_VOLUME_NAMES],
      );
      if (sizes !== null) {
        dockerUnavailable = false;
        volumeBytes = Object.values(sizes).reduce((total, value) => total + value, 0);
      }
    }
    rows.push({
      id: "previousDockerData",
      paths: [stackPath],
      bytes: stackSize.bytes + volumeBytes,
      approximate: stackSize.approximate,
      dockerUnavailable,
    });
  }

  return rows;
}
