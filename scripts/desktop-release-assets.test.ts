import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// electron-builder's ${arch} is target-specific on Linux: the x64 AppImage is
// x86_64 and the x64 deb is amd64. Every other platform keeps one arch label.
const INSTALLERS = [
  {
    directory: "mac-arm64",
    files: ["mac-arm64.dmg", "mac-arm64.zip"],
    feed: "latest-mac.yml",
    feedAsset: "mac-arm64.zip",
  },
  {
    directory: "mac-x64",
    files: ["mac-x64.dmg", "mac-x64.zip"],
    feed: "latest-mac.yml",
    feedAsset: "mac-x64.zip",
  },
  {
    directory: "linux-x64",
    files: ["linux-x86_64.AppImage", "linux-amd64.deb"],
    feed: "latest-linux.yml",
    feedAsset: "linux-amd64.deb",
  },
  { directory: "win-x64", files: ["win-x64.exe"], feed: "latest.yml", feedAsset: "win-x64.exe" },
] as const;

async function stageSource(source: string, version: string) {
  for (const { directory, files, feed, feedAsset } of INSTALLERS) {
    const target = path.join(source, directory);
    await mkdir(target, { recursive: true });
    for (const file of files) await writeFile(path.join(target, `ardur-${version}-${file}`), file);
    await writeFile(
      path.join(target, feed),
      `version: ${version}\nfiles:\n  - url: ardur-${version}-${feedAsset}\n    sha512: fixture\n`,
    );
  }
}

it("assembles required installers, merges both Mac architectures, and refuses missing feeds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "release-assets-"));
  const source = path.join(dir, "source");
  const output = path.join(dir, "output");
  const version = "0.1.0-alpha.1";
  try {
    await stageSource(source, version);
    execFileSync(
      process.execPath,
      ["scripts/desktop-release-assets.mjs", version, source, output],
      { stdio: "pipe" },
    );
    const feed = await readFile(path.join(output, "latest-mac.yml"), "utf8");
    expect(feed).toContain("mac-arm64.zip");
    expect(feed).toContain("mac-x64.zip");
    expect(await readFile(path.join(output, "ardur.rb"), "utf8")).not.toContain("@ARM64_SHA256@");
    const checksums = await readFile(path.join(output, "checksums.txt"), "utf8");
    for (const file of [
      "install.sh",
      "ArdurAI.ArdurBot.installer.yaml",
      "ArdurAI.ArdurBot.locale.en-US.yaml",
      "ArdurAI.ArdurBot.yaml",
    ]) {
      const content = await readFile(path.join(output, file));
      const hash = createHash("sha256").update(content).digest("hex");
      expect(checksums).toContain(`${hash}  ${file}`);
    }
    await rm(path.join(source, "win-x64/latest.yml"));
    expect(() =>
      execFileSync(
        process.execPath,
        ["scripts/desktop-release-assets.mjs", version, source, output],
        { stdio: "pipe" },
      ),
    ).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("accepts the produced Linux names without the retired linux-x64 ones", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "release-assets-linux-"));
  const source = path.join(dir, "source");
  const output = path.join(dir, "output");
  const version = "0.1.0-alpha.1";
  try {
    await stageSource(source, version);
    const staged = await readdir(path.join(source, "linux-x64"));
    expect(staged.some((file: string) => file.includes("-linux-x64."))).toBe(false);
    execFileSync(
      process.execPath,
      ["scripts/desktop-release-assets.mjs", version, source, output],
      { stdio: "pipe" },
    );
    const published = await readdir(output);
    expect(published).toContain(`ardur-${version}-linux-x86_64.AppImage`);
    expect(published).toContain(`ardur-${version}-linux-amd64.deb`);
    expect(published.some((file: string) => file.includes("-linux-x64."))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
