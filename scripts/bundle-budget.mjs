import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export async function measureBundle(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, ".vite/manifest.json"), "utf8"));
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  const initial = new Set(
    [...html.matchAll(/(?:src|href)=["']\/?(assets\/[^"' ]+\.js)["']/g)].map((match) => match[1]),
  );
  const seen = new Set();
  function visit(key) {
    if (seen.has(key)) return;
    seen.add(key);
    const entry = manifest[key];
    if (!entry) throw new Error(`Missing manifest dependency: ${key}`);
    if (entry.file.endsWith(".js")) initial.add(entry.file);
    for (const imported of entry.imports ?? []) visit(imported);
  }
  for (const [key, entry] of Object.entries(manifest)) {
    if (entry.isEntry || initial.has(entry.file)) visit(key);
  }
  const files = {};
  for (const file of [...initial].sort()) {
    files[file] = gzipSync(await readFile(path.join(directory, file)), { level: 9 }).length;
  }
  // Stable source ids, plus uniquely named shared chunks, survive hashed file names.
  const names = Object.values(manifest).map((entry) => entry.name);
  const chunks = Object.fromEntries(
    Object.entries(manifest)
      .filter(([, entry]) => entry.file.endsWith(".js"))
      .map(([key, entry]) => [
        entry.src ??
          (names.filter((name) => name === entry.name).length === 1
            ? `chunk:${entry.name}`
            : key.replace(/-[\w-]{8}\.js$/, ".js")),
        {
          file: entry.file,
          lazy: !initial.has(entry.file),
          dynamic: entry.isDynamicEntry ?? false,
        },
      ]),
  );
  return {
    initial: { files, gzipBytes: Object.values(files).reduce((sum, size) => sum + size, 0) },
    chunks,
  };
}

export function bundleWarnings(report, baseline) {
  const warnings = [];
  const growth = report.initial.gzipBytes - baseline.initial.gzipBytes;
  if (growth > 10 * 1024) warnings.push(`Initial JS grew ${growth} bytes gzip; budget is 10240.`);
  for (const [id, chunk] of Object.entries(baseline.chunks)) {
    if (chunk.lazy && !report.chunks[id]?.lazy) {
      warnings.push(
        `Lazy boundary changed: ${id}. Review removal or eager loading before refreshing the baseline.`,
      );
    }
  }
  for (const [id, chunk] of Object.entries(report.chunks)) {
    if (chunk.dynamic && !chunk.lazy)
      warnings.push(`Dynamic entry is in the initial graph: ${id}.`);
  }
  return warnings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await measureBundle(process.argv[2] ?? "apps/web/dist");
  const warnings = process.argv[3]
    ? bundleWarnings(report, JSON.parse(await readFile(process.argv[3], "utf8")))
    : [];
  console.log(JSON.stringify({ ...report, warnings }, null, 2));
  for (const warning of warnings) console.warn(`::warning title=Bundle budget::${warning}`);
}
