import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { generateCask, generateWinget, releaseVersion } from "./desktop-release.mjs";

// Reuse electron-builder's YAML codec; no new dependency or runtime code.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(
  require.resolve("electron-builder", { paths: ["apps/desktop"] }),
);
const yaml = builderRequire("js-yaml");
const [version, source, destination] = process.argv.slice(2);
releaseVersion(`v${version}`, version);
await mkdir(destination, { recursive: true });
const feeds = new Map();
for (const directory of await readdir(source)) {
  for (const file of await readdir(path.join(source, directory))) {
    const from = path.join(source, directory, file);
    if (file.endsWith(".yml")) {
      const feed = yaml.load(await readFile(from, "utf8"));
      if (feed.version !== version) throw new Error("Update feed version mismatch.");
      const previous = feeds.get(file);
      feeds.set(file, previous ? { ...previous, files: [...previous.files, ...feed.files] } : feed);
    } else await copyFile(from, path.join(destination, file));
  }
}
for (const [platform, arch, extensions] of [
  ["mac", "arm64", ["dmg", "zip"]],
  ["mac", "x64", ["dmg", "zip"]],
  ["linux", "x64", ["AppImage", "deb"]],
  ["win", "x64", ["exe"]],
]) {
  for (const extension of extensions)
    await readFile(path.join(destination, `ardur-bot-${version}-${platform}-${arch}.${extension}`));
}
const armLinux = (await readdir(destination)).filter((file) => file.includes("-linux-arm64."));
if (armLinux.length > 0) {
  for (const extension of ["AppImage", "deb"])
    await readFile(path.join(destination, `ardur-bot-${version}-linux-arm64.${extension}`));
} else
  console.warn(
    "::warning title=Linux arm64::Optional ARM Linux artifacts are unavailable for this preview.",
  );
// GitHub selects pre-releases through its release feed; the builder emits latest*.yml.
for (const suffix of ["", "-mac", "-linux"]) {
  if (!feeds.has(`latest${suffix}.yml`)) throw new Error("Missing platform update feed.");
}
for (const [file, feed] of feeds) {
  for (const entry of feed.files) {
    if (path.basename(entry.url) !== entry.url) throw new Error("Unexpected update asset URL.");
    await readFile(path.join(destination, entry.url));
  }
  await writeFile(path.join(destination, file), yaml.dump(feed));
}
await copyFile("scripts/install.sh", path.join(destination, "install.sh"));
await generateCask(version, destination, path.join(destination, "ardur-bot.rb"));
await generateWinget(version, destination, destination);

const crypto = await import("node:crypto");
let checksums = "";
// Exclude update feeds (.yml) and blockmaps (.blockmap) managed by electron-builder,
// the Homebrew cask (ardur-bot.rb), and checksums.txt itself.
const allFiles = (await readdir(destination)).filter(
  (f) => !f.endsWith(".yml") && !f.endsWith(".blockmap"),
);
for (const f of allFiles.sort()) {
  if (f === "checksums.txt" || f === "ardur-bot.rb") continue;
  const content = await readFile(path.join(destination, f));
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  checksums += `${hash}  ${f}\n`;
}
await writeFile(path.join(destination, "checksums.txt"), checksums);
