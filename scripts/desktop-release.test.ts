import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { generateCask, releaseNotes, releaseVersion } from "./desktop-release.mjs";
import { syncDesktopVersion } from "./desktop-version.mjs";

describe("release metadata", () => {
  it("accepts a preview matching the root version and rejects mismatched or unsafe refs", () => {
    expect(releaseVersion("v0.1.0-alpha.1", "0.1.0-alpha.1")).toBe("0.1.0-alpha.1");
    for (const tag of ["dev", "v0.2.0", "v0.1.0;echo", "v0.1.0/other"])
      expect(() => releaseVersion(tag, "0.1.0")).toThrow();
  });
  it("groups conventional prefixes without publishing subjects, scopes, or identities", () => {
    const notes = releaseNotes([
      "feat(private/fixture): Fixture Person changed a secret",
      "fix: sensitive@example.invalid",
      "perf: /private/fixture",
      "unconventional subject",
    ]);
    expect(notes).toContain("Features: 1 change");
    expect(notes).toContain("Fixes: 1 change");
    expect(notes).toContain("Performance: 1 change");
    expect(notes).not.toMatch(/Person|private|fixture|sensitive|unconventional/);
  });
  it("derives the desktop version and both cask checksums from build inputs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "release-fixture-"));
    try {
      await mkdir(path.join(dir, "apps/desktop"), { recursive: true });
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3-alpha.1" }));
      await writeFile(
        path.join(dir, "apps/desktop/package.json"),
        JSON.stringify({ version: "0.0.0", name: "fixture" }),
      );
      expect(await syncDesktopVersion(pathToFileURL(`${dir}/`))).toBe("1.2.3-alpha.1");
      expect(
        JSON.parse(await readFile(path.join(dir, "apps/desktop/package.json"), "utf8")).version,
      ).toBe("1.2.3-alpha.1");
      for (const arch of ["arm64", "x64"])
        await writeFile(path.join(dir, `ardur-bot-1.2.3-alpha.1-mac-${arch}.dmg`), arch);
      await generateCask("1.2.3-alpha.1", dir, path.join(dir, "Casks/ardur-bot.rb"));
      const cask = await readFile(path.join(dir, "Casks/ardur-bot.rb"), "utf8");
      expect(cask).toContain('version "1.2.3-alpha.1"');
      for (const arch of ["arm64", "x64"])
        expect(cask).toContain(createHash("sha256").update(arch).digest("hex"));
      expect(cask).not.toContain("@VERSION@");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
