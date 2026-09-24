import { constants } from "node:fs";
import path from "node:path";
import type { MemoryFilesystem } from "./markdown-files.js";

/** Deterministic test filesystem. No IO or networking; supports failures at the atomic publish boundary. */
export function memoryFilesystemFake() {
  const entries = new Map<string, { kind: "file" | "directory" | "symlink"; text: string }>([
    ["/", { kind: "directory", text: "" }],
    ["/fixture", { kind: "directory", text: "" }],
    ...["space-a", "space-b", "quarantine"].map(
      (name) => [`/fixture/${name}`, { kind: "directory", text: "" }] as const,
    ),
  ]);
  let failRename: string | undefined;
  const error = (code: string) => Object.assign(new Error("Injected filesystem failure"), { code });
  const get = (name: string) => {
    const value = entries.get(name);
    if (!value) throw error("ENOENT");
    return value;
  };
  const stat = (name: string) => ({
    isSymbolicLink: () => get(name).kind === "symlink",
    isDirectory: () => get(name).kind === "directory",
    isFile: () => get(name).kind === "file",
    size: Buffer.byteLength(get(name).text),
  });
  const filesystem = {
    lstat: async (name: string) => {
      get(name);
      return stat(name);
    },
    realpath: async (name: string) => name,
    mkdir: async (name: string) => {
      if (entries.has(name)) throw error("EEXIST");
      get(path.dirname(name));
      entries.set(name, { kind: "directory", text: "" });
    },
    open: async (name: string, flags: number) => {
      const exists = entries.has(name);
      if (exists && flags & constants.O_EXCL) throw error("EEXIST");
      if (exists && get(name).kind === "symlink") throw error("ELOOP");
      if (!exists && !(flags & constants.O_CREAT)) throw error("ENOENT");
      if (!exists) entries.set(name, { kind: "file", text: "" });
      return {
        stat: async () => stat(name),
        readFile: async () => get(name).text,
        writeFile: async (text: string) => {
          get(name).text = text;
        },
        sync: async () => undefined,
        close: async () => undefined,
      };
    },
    rename: async (from: string, to: string) => {
      if (failRename && to.endsWith(failRename)) {
        failRename = undefined;
        throw error("EIO");
      }
      entries.set(to, { ...get(from) });
      entries.delete(from);
    },
    unlink: async (name: string) => {
      get(name);
      entries.delete(name);
    },
    readdir: async (name: string) =>
      [...entries.keys()].filter((entry) => path.dirname(entry) === name),
  } as unknown as MemoryFilesystem;
  return {
    filesystem,
    entries,
    failNextRename: (suffix: string) => {
      failRename = suffix;
    },
  };
}
