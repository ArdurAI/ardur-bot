import path from "node:path";
import { MAX_REGISTERED_FOLDERS, parseRegisteredFolders } from "@ardurbot/contracts/host-folders";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

/**
 * The folders bots may use in local mode. Only the desktop app writes this file; the API,
 * the IDE, and the command sandbox read it. A pairing with another server keeps its own
 * folders, which never apply here.
 */
const LOCAL_FOLDERS_FILE = "local-folders.json";

export function localFoldersFile(userDataDir: string): string {
  return path.join(userDataDir, LOCAL_FOLDERS_FILE);
}

export class LocalFolders {
  constructor(private readonly file: string) {}

  async list(): Promise<string[]> {
    return parseRegisteredFolders(await readPrivateFile(this.file, 256 * 1024), path.isAbsolute);
  }

  async add(folder: string): Promise<void> {
    const folders = await this.list();
    if (folders.includes(folder)) return;
    if (folders.length >= MAX_REGISTERED_FOLDERS) {
      throw new Error("Remove a folder before adding another.");
    }
    await this.save([...folders, folder]);
  }

  async remove(folder: string): Promise<void> {
    await this.save((await this.list()).filter((entry) => entry !== folder));
  }

  private save(folders: string[]): Promise<void> {
    return writePrivateFile(this.file, `${JSON.stringify(folders)}\n`);
  }
}
