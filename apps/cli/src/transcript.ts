import type { FileHandle } from "node:fs/promises";
import { link, lstat, mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { safeDiagnostic } from "./text.js";
import { CliError } from "./transport.js";
import { windowsAcl } from "./windows-acl.js";

export interface Transcript {
  write: (record: Record<string, unknown>) => Promise<void>;
  close: () => Promise<void>;
}
const unsafe = () => new CliError("Choose a safe private transcript file.", 3);
async function checkParents(directory: string) {
  for (let current = directory; ; current = path.dirname(current)) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
    if (path.dirname(current) === current) break;
  }
}
function redact(value: unknown): unknown {
  if (typeof value === "string") return safeDiagnostic(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
}
export async function prepareTranscript(target: string, home = homedir()): Promise<Transcript> {
  let file: FileHandle | undefined;
  let staging: string | undefined;
  let temporary: string | undefined;
  try {
    if (!target || target.split(/[\\/]/).includes("..")) throw unsafe();
    // Relative files stay under home. An absolute path explicitly selects another parent.
    const destination = path.isAbsolute(target) ? path.resolve(target) : path.resolve(home, target);
    const parent = path.dirname(destination);
    await checkParents(parent);
    const parentStat = await lstat(parent);
    if (
      process.platform !== "win32" &&
      (parentStat.uid !== process.getuid?.() || (parentStat.mode & 0o022) !== 0)
    )
      throw unsafe();
    staging = await mkdtemp(path.join(parent, ".ardur-transcript-"));
    await windowsAcl(staging, true);
    temporary = path.join(staging, "record");
    file = await open(temporary, "wx", 0o600);
    await windowsAcl(temporary);
    await checkParents(parent);
    const currentParent = await lstat(parent);
    if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino)
      throw unsafe();
    // A hard link publishes the already-private file without overwriting any target.
    await link(temporary, destination);
    await unlink(temporary);
    temporary = undefined;
    await rmdir(staging);
    staging = undefined;
    const handle = file;
    return {
      async write(record) {
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.nlink !== 1) throw unsafe();
          const encoded = Buffer.from(`${JSON.stringify(redact(record))}\n`);
          await handle.truncate(0);
          for (let offset = 0; offset < encoded.length; ) {
            const { bytesWritten } = await handle.write(
              encoded,
              offset,
              encoded.length - offset,
              offset,
            );
            if (bytesWritten === 0) throw unsafe();
            offset += bytesWritten;
          }
          await handle.sync();
        } catch {
          throw new CliError("The private transcript could not be saved.", 3);
        }
      },
      close: () => handle.close(),
    };
  } catch {
    await file?.close();
    throw unsafe();
  } finally {
    if (temporary) await unlink(temporary).catch(() => undefined);
    if (staging) await rmdir(staging).catch(() => undefined);
  }
}
