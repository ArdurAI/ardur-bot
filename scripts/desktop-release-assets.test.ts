import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("assembles required installers, merges both Mac architectures, and refuses missing feeds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "release-assets-"));
  const source = path.join(dir, "source");
  const output = path.join(dir, "output");
  const version = "0.1.0-alpha.1";
  try {
    for (const [platform, arch, extensions, feed] of [
      ["mac", "arm64", ["dmg", "zip"], "latest-mac.yml"],
      ["mac", "x64", ["dmg", "zip"], "latest-mac.yml"],
      ["linux", "x64", ["AppImage", "deb"], "latest-linux.yml"],
      ["win", "x64", ["exe"], "latest.yml"],
    ] as const) {
      const target = path.join(source, `${platform}-${arch}`);
      await mkdir(target, { recursive: true });
      for (const extension of extensions)
        await writeFile(
          path.join(target, `ardur-bot-${version}-${platform}-${arch}.${extension}`),
          `${platform}-${arch}`,
        );
      await writeFile(
        path.join(target, feed),
        `version: ${version}\nfiles:\n  - url: ardur-bot-${version}-${platform}-${arch}.${extensions.at(-1)}\n    sha512: fixture\n`,
      );
    }
    execFileSync(
      process.execPath,
      ["scripts/desktop-release-assets.mjs", version, source, output],
      { stdio: "pipe" },
    );
    const feed = await readFile(path.join(output, "latest-mac.yml"), "utf8");
    expect(feed).toContain("mac-arm64.zip");
    expect(feed).toContain("mac-x64.zip");
    expect(await readFile(path.join(output, "ardur-bot.rb"), "utf8")).not.toContain(
      "@ARM64_SHA256@",
    );
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
