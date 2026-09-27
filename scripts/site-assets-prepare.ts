import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type SiteProduct, SiteProductSchema } from "../packages/contracts/src/site-product.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function contentDigest(
  product: SiteProduct,
  screenshots: ReadonlyMap<string, Buffer>,
  media: ReadonlyMap<string, Buffer> = new Map(),
): string {
  const { generatedAt: _generatedAt, source: _source, ...facts } = product;
  const hash = createHash("sha256").update(JSON.stringify(facts));
  for (const file of [...screenshots.keys(), ...media.keys()].sort()) {
    hash.update(file);
    hash.update(screenshots.get(file) ?? media.get(file)!);
  }
  return hash.digest("hex");
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
  const expectedFiles = [
    "product.json",
    ...product.screenshots.map((shot) => shot.file),
    ...(product.videos?.flatMap((video) => Object.values(video.files)) ?? []),
  ].sort();
  if (files.slice().sort().join("\n") !== expectedFiles.join("\n")) return null;
  return {
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
  };
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
  const digest = contentDigest(product, screenshots, media);
  const old = await existingAssets();
  const changed = !old || contentDigest(old.product, old.screenshots, old.media) !== digest;
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  const summary = changed
    ? `### Site assets ready\n\n- Product facts, ${screenshots.size} screenshots and ${media.size} media files changed.\n- Content SHA-256: \`${digest}\`\n- Files: ${["product.json", ...screenshots.keys(), ...media.keys()].join(", ")}\n`
    : `### Site assets unchanged\n\n- Content SHA-256: \`${digest}\`\n- No commit published.\n`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!changed) {
    console.log("Site assets unchanged.");
    return;
  }
  await mkdir(path.join(stage, "screenshots"), { recursive: true });
  if (media.size) await mkdir(path.join(stage, "media"), { recursive: true });
  await writeFile(
    path.join(stage, "product.json"),
    `${JSON.stringify(publishedProduct(product, commit, new Date()), null, 2)}\n`,
  );
  for (const [file, bytes] of screenshots) await writeFile(path.join(stage, file), bytes);
  for (const [file, bytes] of media) await writeFile(path.join(stage, file), bytes);
  console.log(`Site assets ready: ${digest}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepare().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
