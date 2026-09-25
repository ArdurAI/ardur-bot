import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export async function measureBundle(directory) {
  const root = await realpath(directory);
  async function asset(file) {
    const resolved = await realpath(path.resolve(root, file));
    if (!resolved.startsWith(`${root}${path.sep}`))
      throw new Error("Asset escapes bundle directory");
    return readFile(resolved);
  }
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
    files[file] = gzipSync(await asset(file), { level: 9 }).length;
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
  const totals = { "renderer-assets": 0, css: 0, fonts: 0 };
  async function inventory(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Bundle inventory cannot follow symbolic links");
      if (entry.isDirectory()) await inventory(file);
      else if (entry.isFile()) {
        const { size } = await stat(file);
        totals["renderer-assets"] += size;
        if (/\.css$/i.test(entry.name)) totals.css += size;
        if (/\.(woff2?|ttf|otf)$/i.test(entry.name)) totals.fonts += size;
      }
    }
  }
  await inventory(root);
  return {
    initial: { files, gzipBytes: Object.values(files).reduce((sum, size) => sum + size, 0) },
    chunks,
    totals,
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
  for (const [category, bytes] of Object.entries(baseline.totals ?? {})) {
    const current = report.totals?.[category];
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(current) || current < 0)
      warnings.push(`Missing or invalid artifact category: ${category}.`);
    else if (current - bytes > bytes * 0.05)
      warnings.push(`Total artifact grew beyond 5%: ${category}.`);
  }
  return warnings;
}

export const ARTIFACT_CATEGORIES = Object.freeze([
  "css",
  "fonts",
  "renderer-assets",
  "main",
  "preload",
  "host",
  "asar",
  "native-modules",
  "installer",
  "download",
  "installed",
]);

/** Static diagnostics complement schema-3 evidence; raw sizes alone are not release provenance. */
export function bundleVerdict(candidate, parent, fixedRelease) {
  const reasons = [];
  const comparisons = [];
  for (const [scope, baseline] of [
    ["parent", parent],
    ["fixed-release", fixedRelease],
  ]) {
    if (!baseline) {
      reasons.push({ code: "missing-baseline", scope });
      continue;
    }
    try {
      for (const report of [baseline, candidate]) {
        if (
          !Number.isSafeInteger(report.initial.gzipBytes) ||
          report.initial.gzipBytes < 0 ||
          !report.chunks ||
          typeof report.chunks !== "object" ||
          Array.isArray(report.chunks)
        )
          throw new Error("invalid bundle");
        for (const chunk of Object.values(report.chunks)) {
          if (!chunk || typeof chunk.lazy !== "boolean" || typeof chunk.dynamic !== "boolean")
            throw new Error("invalid chunk");
        }
        for (const category of ARTIFACT_CATEGORIES) {
          if (!Number.isSafeInteger(report.totals?.[category]) || report.totals[category] < 0)
            reasons.push({ code: "incomplete-artifact-category", scope, category });
        }
      }
      const warnings = bundleWarnings(candidate, baseline);
      comparisons.push({ scope, warnings });
      for (const warning of warnings)
        reasons.push({
          code: warning.startsWith("Missing") ? "invalid-artifact-value" : "budget-regression",
          scope,
          detail: warning,
        });
    } catch {
      reasons.push({ code: "invalid-bundle-report", scope });
    }
  }
  reasons.push({
    code: "schema-3-evidence-required",
    scope: "release",
    detail:
      "Use the performance comparator for calibrated policy, artifact provenance and complete release evidence.",
  });
  const regressed = reasons.some((reason) => reason.code === "budget-regression");
  return {
    status: regressed ? "regression" : "incomplete",
    exitCode: regressed ? 1 : 2,
    comparisons,
    reasons,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const report = await measureBundle(process.argv[2] ?? "apps/web/dist");
    if (!process.argv[3]) console.log(JSON.stringify(report, null, 2));
    else {
      const parent = JSON.parse(await readFile(process.argv[3], "utf8"));
      const fixed = process.argv[4] ? JSON.parse(await readFile(process.argv[4], "utf8")) : null;
      const verdict = bundleVerdict(report, parent, fixed);
      console.log(JSON.stringify({ ...report, ...verdict }, null, 2));
      console.error(`Bundle budget: ${verdict.status}.`);
      process.exitCode = verdict.exitCode;
    }
  } catch {
    console.log(
      JSON.stringify({
        status: "incomplete",
        exitCode: 2,
        reasons: [{ code: "invalid-bundle-input", scope: "cli" }],
      }),
    );
    process.exitCode = 2;
  }
}
