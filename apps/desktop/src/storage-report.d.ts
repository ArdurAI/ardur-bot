/** Serializable storage rows; no Electron objects or credentials cross the bridge. */
export type DesktopStorageRowId =
  | "database"
  | "computerHomes"
  | "checkpoints"
  | "artifacts"
  | "boards"
  | "sessions"
  | "appCache"
  | "previousDockerData";

export interface DesktopStorageRow {
  id: DesktopStorageRowId;
  /** Absolute paths on this machine that make up the row. */
  paths: string[];
  bytes: number;
  /** True once the entry cap stopped the walk; `bytes` is then a lower bound. */
  approximate: boolean;
  /** `previousDockerData` only: the Docker engine did not answer, so its volumes are not counted. */
  dockerUnavailable?: boolean;
}

export interface StorageBridge {
  usage(): Promise<DesktopStorageRow[]>;
  /** Clears the HTTP cache, code cache, cache storage and service workers, then reports fresh sizes. */
  clearCaches(): Promise<DesktopStorageRow[]>;
}
