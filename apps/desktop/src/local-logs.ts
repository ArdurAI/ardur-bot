import { open, rename, rm, stat } from "node:fs/promises";
/** One active file and one rotated file. 10 MiB matches the desktop log cap. */
export const LOG_CAP_BYTES = 10 * 1024 * 1024;

const writers = new Map<string, Promise<void>>();

export function writeServiceLog(
  file: string,
  chunk: Buffer | string,
  cap = LOG_CAP_BYTES,
): Promise<void> {
  const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  const previous = writers.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => appendCappedLog(file, bytes, cap));
  writers.set(file, next);
  return next;
}

export async function appendCappedLog(
  file: string,
  chunk: Buffer,
  cap = LOG_CAP_BYTES,
): Promise<void> {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    size = 0;
  }
  if (size > 0 && size + chunk.byteLength > cap) {
    await rm(`${file}.1`, { force: true });
    await rename(file, `${file}.1`);
  }
  const handle = await open(file, "a", 0o600);
  try {
    await handle.write(chunk);
  } finally {
    await handle.close();
  }
}
