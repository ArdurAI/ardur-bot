import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SiteProductSchema } from "../packages/contracts/src/site-product";
import { contentDigest, publishedProduct } from "./site-assets-prepare";

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
});
