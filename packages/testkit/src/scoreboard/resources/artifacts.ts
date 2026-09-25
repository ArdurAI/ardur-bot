import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { canonicalSerialize, contentDigest } from "../manifest.js";
import type { Reading } from "./contracts.js";
import { measured, unavailable } from "./contracts.js";

export const PACKAGED_ASSET_CATEGORIES = [
  "initial-js-raw",
  "initial-js-gzip",
  "initial-js-brotli",
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
] as const;
export type AssetCategory = (typeof PACKAGED_ASSET_CATEGORIES)[number];
interface AssetEntry {
  path: string;
  bytes: number;
  sha256: string;
  kind: "file" | "symlink";
}

/** Stream large packages, preserve internal framework links, and reject escaping links and changed files. */
export async function inventoryArtifact(root: string) {
  const resolved = await realpath(root);
  const entries: AssetEntry[] = [];
  const walk = async (file: string, relative: string): Promise<void> => {
    const before = await lstat(file);
    if (before.isSymbolicLink()) {
      const destination = await realpath(file);
      if (destination !== resolved && !destination.startsWith(`${resolved}${path.sep}`))
        throw new Error("Artifact symbolic link escapes root");
      const target = await readlink(file);
      if (path.isAbsolute(target)) throw new Error("Artifact contains an absolute symbolic link");
      entries.push({
        path: relative,
        bytes: Buffer.byteLength(target),
        sha256: createHash("sha256").update(target).digest("hex"),
        kind: "symlink",
      });
    } else if (before.isDirectory()) {
      for (const entry of (await readdir(file)).sort())
        await walk(path.join(file, entry), relative ? `${relative}/${entry}` : entry);
    } else if (before.isFile()) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      const after = await lstat(file);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== after.ino
      )
        throw new Error("Artifact changed during measurement");
      entries.push({
        path: relative || "artifact",
        bytes: before.size,
        sha256: hash.digest("hex"),
        kind: "file",
      });
    } else throw new Error("Unsupported artifact entry");
  };
  await walk(resolved, "");
  return {
    entries,
    bytes: entries.reduce((sum, file) => sum + file.bytes, 0),
    sha256: contentDigest(entries),
  };
}

/** Missing categories stay missing. Categories overlap and must never be summed into installed size. */
export async function collectPackagedArtifacts(options: {
  renderer?: string;
  roots?: Partial<
    Record<
      Exclude<
        AssetCategory,
        | "initial-js-raw"
        | "initial-js-gzip"
        | "initial-js-brotli"
        | "css"
        | "fonts"
        | "renderer-assets"
      >,
      string
    >
  >;
}) {
  const categories = Object.fromEntries(
    PACKAGED_ASSET_CATEGORIES.map((key) => [key, unavailable()]),
  ) as Record<AssetCategory, Reading>;
  const inventories: Partial<Record<AssetCategory, Awaited<ReturnType<typeof inventoryArtifact>>>> =
    {};
  let initialFiles: string[] = [];
  if (options.renderer) {
    const root = await realpath(options.renderer);
    const inventory = await inventoryArtifact(root);
    inventories["renderer-assets"] = inventory;
    categories["renderer-assets"] = measured(inventory.bytes);
    categories.css = measured(
      inventory.entries
        .filter((e) => e.kind === "file" && /\.css$/i.test(e.path))
        .reduce((sum, e) => sum + e.bytes, 0),
    );
    categories.fonts = measured(
      inventory.entries
        .filter((e) => e.kind === "file" && /\.(woff2?|ttf|otf)$/i.test(e.path))
        .reduce((sum, e) => sum + e.bytes, 0),
    );
    const manifest = JSON.parse(
      await readFile(path.join(root, ".vite/manifest.json"), "utf8"),
    ) as Record<string, { file: string; isEntry?: boolean; imports?: string[] }>;
    const html = await readFile(path.join(root, "index.html"), "utf8");
    const files = new Set(
      [...html.matchAll(/(?:src|href)=["']\/?(assets\/[^"' ]+\.js)["']/g)].map((m) => m[1]!),
    );
    const seen = new Set<string>();
    const visit = (key: string) => {
      if (seen.has(key)) return;
      seen.add(key);
      const entry = manifest[key];
      if (!entry) throw new Error("Missing initial dependency");
      if (entry.file.endsWith(".js")) files.add(entry.file);
      for (const imported of entry.imports ?? []) visit(imported);
    };
    for (const [key, entry] of Object.entries(manifest))
      if (entry.isEntry || files.has(entry.file)) visit(key);
    if (!files.size) throw new Error("Empty initial renderer graph");
    let raw = 0,
      gzip = 0,
      brotli = 0;
    initialFiles = [...files].sort();
    for (const file of initialFiles) {
      const resolved = await realpath(path.resolve(root, file));
      if (!resolved.startsWith(`${root}${path.sep}`))
        throw new Error("Initial asset escapes renderer");
      const bytes = await readFile(resolved);
      const expected = inventory.entries.find((e) => e.path === file);
      if (!expected || expected.sha256 !== createHash("sha256").update(bytes).digest("hex"))
        throw new Error("Initial asset changed during collection");
      raw += bytes.length;
      gzip += gzipSync(bytes, { level: 9 }).length;
      brotli += brotliCompressSync(bytes).length;
    }
    categories["initial-js-raw"] = measured(raw);
    categories["initial-js-gzip"] = measured(gzip);
    categories["initial-js-brotli"] = measured(brotli);
  }
  for (const [key, root] of Object.entries(options.roots ?? {})) {
    if (!PACKAGED_ASSET_CATEGORIES.includes(key as AssetCategory))
      throw new Error("Unknown artifact category");
    const inventory = await inventoryArtifact(root);
    inventories[key as AssetCategory] = inventory;
    categories[key as AssetCategory] = measured(inventory.bytes);
  }
  const body = {
    version: 1,
    categories,
    inventories,
    initialFiles,
    installedDefinition: "logical-file-and-relative-link-bytes-not-allocated-blocks",
  };
  return { ...body, sha256: contentDigest(body), raw: canonicalSerialize(body) };
}
