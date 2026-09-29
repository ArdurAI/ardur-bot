// biome-ignore lint/suspicious/noUndeclaredEnvVars: used in CI script
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FeatureDocumentationEvidenceSchema,
  type FeatureDocumentationManifest,
} from "../packages/contracts/src/feature-documentation.ts";
import { type SiteProduct, SiteProductSchema } from "../packages/contracts/src/site-product.ts";
import {
  assertDocumentationPng,
  loadValidatedFeatureDocs,
  publishedDocumentation,
} from "./feature-docs.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function contentDigest(
  product: SiteProduct,
  screenshots: ReadonlyMap<string, Buffer>,
  media: ReadonlyMap<string, Buffer> = new Map(),
  docs: ReadonlyMap<string, Buffer> = new Map(),
): string {
  const { generatedAt: _generatedAt, source: _source, ...facts } = product;
  const hash = createHash("sha256").update(JSON.stringify(facts));
  for (const file of [...screenshots.keys(), ...media.keys(), ...docs.keys()].sort()) {
    hash.update(file);
    hash.update(screenshots.get(file) ?? media.get(file) ?? docs.get(file)!);
  }
  return hash.digest("hex");
}

export function expectedAssetFiles(product: SiteProduct): string[] {
  return [
    "product.json",
    ...product.screenshots.map((shot) => shot.file),
    ...(product.videos?.flatMap((video) => Object.values(video.files)) ?? []),
    ...(product.documentation?.screenshots.map((shot) => shot.file) ?? []),
  ].sort();
}

/** Validate a complete snapshot before treating its content hash as comparable. */
export function validateAssetSnapshot(
  product: SiteProduct,
  files: ReadonlyMap<string, Buffer>,
): void {
  const expected = expectedAssetFiles(product).filter((file) => file !== "product.json");
  if ([...files.keys()].sort().join("\n") !== expected.join("\n"))
    throw new Error("Asset files differ from the product snapshot.");
  for (const shot of product.documentation?.screenshots ?? [])
    assertDocumentationPng(files.get(shot.file)!, shot.width, shot.height, shot.file);
}

/** Read only declared captures from a local source tree; no network or Git state is needed. */
export async function loadDocumentationAssets(
  product: SiteProduct,
  siteRoot: string,
  hashes: ReadonlyMap<string, string>,
  manifest: FeatureDocumentationManifest,
): Promise<Map<string, Buffer>> {
  const docsDir = path.join(siteRoot, "docs");
  const listed = await readdir(docsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && !manifest.screenshots.length) return [];
    throw error;
  });
  const shots = product.documentation?.screenshots ?? [];
  const expected = manifest.screenshots.map((shot) => path.basename(shot.file)).sort();
  if (listed.sort().join("\n") !== expected.join("\n"))
    throw new Error("site/docs contains missing or unreferenced documentation captures.");
  const canonicalRoot = await realpath(siteRoot);
  const canonicalDocs = await realpath(docsDir).catch(() => null);
  if (canonicalDocs && canonicalDocs !== path.join(canonicalRoot, "docs"))
    throw new Error("site/docs resolves outside the site source tree.");
  const docs = new Map<string, Buffer>();
  for (const shot of shots) {
    const resolved = await realpath(path.join(siteRoot, shot.file));
    if (!resolved.startsWith(`${canonicalDocs}${path.sep}`))
      throw new Error(`${shot.file} resolves outside site/docs.`);
    const bytes = await readFile(resolved);
    assertDocumentationPng(bytes, shot.width, shot.height, shot.file);
    if (createHash("sha256").update(bytes).digest("hex") !== hashes.get(shot.id))
      throw new Error(`${shot.file} does not match its evidence SHA-256.`);
    docs.set(shot.file, bytes);
  }
  return docs;
}

export function publishedProduct(product: SiteProduct, commit: string, at: Date): SiteProduct {
  return SiteProductSchema.parse({
    ...product,
    generatedAt: at.toISOString(),
    source: { repo: "ArdurAI/ardur-bot", ref: "dev", commit },
  });
}

function git(...args: string[]): Buffer {
  return execFileSync("git", args, { cwd: root, maxBuffer: 12 * 1024 * 1024 });
}

async function existingAssets(): Promise<{
  product: SiteProduct;
  screenshots: Map<string, Buffer>;
  media: Map<string, Buffer>;
  docs: Map<string, Buffer>;
} | null> {
  try {
    git("ls-remote", "--exit-code", "origin", "refs/heads/site-assets");
  } catch (error) {
    if ((error as { status?: number }).status === 2) return null;
    throw error;
  }
  git("fetch", "--depth=1", "origin", "refs/heads/site-assets");
  const files = git("ls-tree", "-r", "--name-only", "FETCH_HEAD")
    .toString("utf8")
    .trim()
    .split("\n");
  const parsed = SiteProductSchema.safeParse(
    JSON.parse(git("show", "FETCH_HEAD:product.json").toString("utf8")),
  );
  if (!parsed.success) return null;
  const product = parsed.data;
  const expectedFiles = expectedAssetFiles(product);
  if (files.slice().sort().join("\n") !== expectedFiles.join("\n")) return null;
  const snapshot = {
    product,
    screenshots: new Map(
      product.screenshots.map((shot) => [shot.file, git("show", `FETCH_HEAD:${shot.file}`)]),
    ),
    media: new Map(
      product.videos?.flatMap((video) =>
        Object.values(video.files).map(
          (file) => [file, git("show", `FETCH_HEAD:${file}`)] as const,
        ),
      ) ?? [],
    ),
    docs: new Map(
      product.documentation?.screenshots.map(
        (shot) => [shot.file, git("show", `FETCH_HEAD:${shot.file}`)] as const,
      ) ?? [],
    ),
  };
  try {
    validateAssetSnapshot(
      product,
      new Map([...snapshot.screenshots, ...snapshot.media, ...snapshot.docs]),
    );
  } catch {
    return null;
  }
  return snapshot;
}

async function prepare(): Promise<void> {
  const dir = process.env.SITE_SCREENSHOTS_DIR;
  const stage = process.env.SITE_ASSETS_STAGE;
  const commit = process.env.GITHUB_SHA;
  if (!dir || !stage || !commit || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(
      "SITE_SCREENSHOTS_DIR, SITE_ASSETS_STAGE and a 40-character GITHUB_SHA are required.",
    );
  }
  const product = SiteProductSchema.parse(
    JSON.parse(await readFile(path.join(root, "site/data/product.json"), "utf8")),
  );
  const manifest = await loadValidatedFeatureDocs(root);
  if (JSON.stringify(product.documentation) !== JSON.stringify(publishedDocumentation(manifest)))
    throw new Error("Product documentation is stale; run pnpm site:facts.");
  const evidence = FeatureDocumentationEvidenceSchema.parse(
    JSON.parse(await readFile(path.join(root, "site/data/feature-docs-evidence.json"), "utf8")),
  );
  const hashes = new Map(evidence.screenshots.map((shot) => [shot.id, shot.sha256]));
  const screenshots = new Map<string, Buffer>();
  const media = new Map<string, Buffer>();
  for (const shot of product.screenshots) {
    const bytes = await readFile(path.join(dir, `${shot.id}.png`));
    if (
      bytes.length > 1_500_000 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(16) !== shot.width ||
      bytes.readUInt32BE(20) !== shot.height
    ) {
      throw new Error(
        `${shot.file} must be a ${shot.width}x${shot.height} PNG no larger than 1.5 MB.`,
      );
    }
    screenshots.set(shot.file, bytes);
  }
  for (const video of product.videos ?? [])
    for (const file of Object.values(video.files))
      media.set(file, await readFile(path.join(root, "site", file)));
  const docs = await loadDocumentationAssets(product, path.join(root, "site"), hashes, manifest);
  validateAssetSnapshot(product, new Map([...screenshots, ...media, ...docs]));
  const digest = contentDigest(product, screenshots, media, docs);
  const old = await existingAssets();
  const changed =
    !old || contentDigest(old.product, old.screenshots, old.media, old.docs) !== digest;
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  const summary = changed
    ? `### Site assets ready\n\n- Product facts, ${screenshots.size} homepage screenshots, ${docs.size} documentation screenshots and ${media.size} media files changed.\n- Content SHA-256: \`${digest}\`\n- Files: ${expectedAssetFiles(product).join(", ")}\n`
    : `### Site assets unchanged\n\n- Content SHA-256: \`${digest}\`\n- No commit published.\n`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!changed) {
    console.log("Site assets unchanged.");
    return;
  }
  await mkdir(path.join(stage, "screenshots"), { recursive: true });
  if (media.size) await mkdir(path.join(stage, "media"), { recursive: true });
  if (docs.size) await mkdir(path.join(stage, "docs"), { recursive: true });
  await writeFile(
    path.join(stage, "product.json"),
    `${JSON.stringify(publishedProduct(product, commit, new Date()), null, 2)}\n`,
  );
  for (const [file, bytes] of screenshots) await writeFile(path.join(stage, file), bytes);
  for (const [file, bytes] of media) await writeFile(path.join(stage, file), bytes);
  for (const [file, bytes] of docs) await writeFile(path.join(stage, file), bytes);
  console.log(`Site assets ready: ${digest}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
