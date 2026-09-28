import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SiteProductSchema } from "../packages/contracts/src/site-product";
import {
  contentDigest,
  expectedAssetFiles,
  loadDocumentationAssets,
  publishedProduct,
  validateAssetSnapshot,
} from "./site-assets-prepare";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("site asset publication", () => {
  it("ignores publication metadata in the content hash but detects changed captures", async () => {
    const source = SiteProductSchema.parse(
      JSON.parse(await readFile(path.join(root, "site/data/product.json"), "utf8")),
    );
    const images = new Map([["screenshots/app-chat.png", Buffer.from("fixture")]]);
    const published = publishedProduct(
      source,
      "a".repeat(40),
      new Date("2026-09-27T00:00:00.000Z"),
    );
    expect(published.source).toMatchObject({ ref: "dev", commit: "a".repeat(40) });
    expect(contentDigest(source, images)).toBe(contentDigest(published, images));
    images.set("screenshots/app-chat.png", Buffer.from("changed"));
    expect(contentDigest(source, images)).not.toBe(
      contentDigest(published, new Map([["screenshots/app-chat.png", Buffer.from("fixture")]])),
    );
    const media = new Map([["media/routines-demo.mp4", Buffer.from("video fixture")]]);
    expect(contentDigest(source, images, media)).not.toBe(contentDigest(source, images));
    expect(contentDigest(source, images, media)).not.toBe(
      contentDigest(
        source,
        images,
        new Map([["media/routines-demo.mp4", Buffer.from("changed video")]]),
      ),
    );
  });

  it("requires matching documentation bytes in old and new atomic snapshots", async () => {
    const product = SiteProductSchema.parse(
      JSON.parse(await readFile(path.join(root, "site/data/product.json"), "utf8")),
    );
    const shot = {
      id: "docs-general-open",
      file: "docs/docs-general-open.png",
      alt: "General settings panel.",
      width: 1,
      height: 1,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      platform: "web",
      theme: "light",
      feature: "general",
      step: "open",
    };
    const feature = {
      id: "general",
      aliases: [],
      title: "General",
      summary: "Open general settings.",
      area: "settings",
      order: 10,
      status: "published",
      availableSince: null,
      platforms: { web: "configure", desktop: "configure", mobile: "unavailable" },
      settingsPath: { web: ["Settings", "General"] },
      steps: [
        {
          id: "open",
          aliases: [],
          text: "Open Settings.",
          uiLabels: ["Settings"],
          screenshotId: shot.id,
          expected: "General is visible.",
          availableSince: null,
        },
      ],
      boundaries: [],
      troubleshooting: [],
      related: [],
    };
    const withDocs = SiteProductSchema.parse({
      ...product,
      documentation: {
        manifestVersion: 1,
        locale: "en",
        features: [feature],
        screenshots: [shot],
      },
    });
    expect(
      SiteProductSchema.safeParse({
        ...withDocs,
        documentation: {
          ...withDocs.documentation,
          screenshots: [{ ...shot, file: "docs/../other.png" }],
        },
      }).success,
    ).toBe(false);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
      "base64",
    );
    const hashes = new Map([[shot.id, createHash("sha256").update(png).digest("hex")]]);
    const files = new Map(
      expectedAssetFiles(withDocs)
        .filter((file) => file !== "product.json")
        .map((file) => [file, file === shot.file ? png : Buffer.from("fixture")] as const),
    );
    expect(() => validateAssetSnapshot(withDocs, files)).not.toThrow();
    const old = new Map(files);
    old.delete(shot.file);
    expect(() => validateAssetSnapshot(withDocs, old)).toThrow("differ from the product snapshot");
    old.set(shot.file, Buffer.from("old image"));
    expect(() => validateAssetSnapshot(withDocs, old)).toThrow("must be a 1x1 PNG");
    expect(contentDigest(withDocs, new Map(), new Map(), new Map([[shot.file, png]]))).not.toBe(
      contentDigest(withDocs, new Map(), new Map(), new Map([[shot.file, Buffer.from("changed")]])),
    );
    const siteRoot = await mkdtemp(path.join(os.tmpdir(), "docs-assets-"));
    try {
      await mkdir(path.join(siteRoot, "docs"));
      await writeFile(path.join(siteRoot, shot.file), png);
      await expect(loadDocumentationAssets(withDocs, siteRoot, hashes)).resolves.toEqual(
        new Map([[shot.file, png]]),
      );
      await expect(
        loadDocumentationAssets(withDocs, siteRoot, new Map([[shot.id, "0".repeat(64)]])),
      ).rejects.toThrow("evidence SHA-256");
      await writeFile(path.join(siteRoot, "docs/unused.png"), png);
      await expect(loadDocumentationAssets(withDocs, siteRoot, hashes)).rejects.toThrow(
        "unreferenced",
      );
      await rm(path.join(siteRoot, "docs/unused.png"));
      await rm(path.join(siteRoot, shot.file));
      await symlink(path.join(root, "README.md"), path.join(siteRoot, shot.file));
      await expect(loadDocumentationAssets(withDocs, siteRoot, hashes)).rejects.toThrow(
        "outside site/docs",
      );
    } finally {
      await rm(siteRoot, { recursive: true, force: true });
    }
  });
});
