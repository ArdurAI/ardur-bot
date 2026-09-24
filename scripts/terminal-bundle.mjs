import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const directory = process.argv[2] ?? "apps/web/dist";
const html = await readFile(path.join(directory, "index.html"), "utf8");
const initial = new Set(
  [...html.matchAll(/(?:src|href)="\/(assets\/[^" ]+\.js)"/g)].map((match) => match[1]),
);
const manifest = JSON.parse(await readFile(path.join(directory, ".vite/manifest.json"), "utf8"));
const terminal = Object.keys(manifest).find((key) => key.includes("/terminal/index.tsx"));
if (!terminal) throw new Error("The terminal entry is missing from the production manifest.");
const lazy = new Set();
const seen = new Set();
function visit(key) {
  if (seen.has(key)) return;
  seen.add(key);
  const entry = manifest[key];
  if (!entry) throw new Error(`Missing manifest entry: ${key}`);
  if (!initial.has(entry.file)) lazy.add(entry.file);
  for (const css of entry.css ?? []) lazy.add(css);
  for (const dependency of entry.imports ?? []) visit(dependency);
}
visit(terminal);
const initialCss = new Set(
  [...html.matchAll(/href="\/(assets\/[^" ]+\.css)"/g)].map((match) => match[1]),
);
for (const css of initialCss) lazy.delete(css);
async function measure(files) {
  const result = {};
  for (const file of [...files].sort())
    result[file] = gzipSync(await readFile(path.join(directory, file)), { level: 9 }).length;
  return { files: result, gzipBytes: Object.values(result).reduce((sum, size) => sum + size, 0) };
}
const result = { initial: await measure(initial), terminal: await measure(lazy) };
if (process.argv[3]) {
  const baseline = JSON.parse(await readFile(process.argv[3], "utf8"));
  result.initialGrowthBytes =
    result.initial.gzipBytes - (baseline.initial?.gzipBytes ?? baseline.gzipBytes);
  if (result.initialGrowthBytes > 10 * 1024) process.exitCode = 1;
}
console.log(JSON.stringify(result, null, 2));
