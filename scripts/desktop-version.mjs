import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
export async function syncDesktopVersion(base = root) {
  const source = JSON.parse(await readFile(new URL("package.json", base), "utf8"));
  const target = new URL("apps/desktop/package.json", base);
  const desktop = JSON.parse(await readFile(target, "utf8"));
  desktop.version = source.version;
  await writeFile(target, `${JSON.stringify(desktop, null, 2)}\n`);
  return source.version;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await syncDesktopVersion();
