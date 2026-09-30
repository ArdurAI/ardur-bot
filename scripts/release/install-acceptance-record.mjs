import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseVersion } from "../desktop-release.mjs";

export const INSTALL_TARGETS = [
  { platform: "mac", arch: "arm64", files: ["mac-arm64.dmg", "mac-arm64.zip"] },
  { platform: "mac", arch: "x64", files: ["mac-x64.dmg", "mac-x64.zip"] },
  { platform: "linux", arch: "x64", files: ["linux-amd64.deb", "linux-x86_64.AppImage"] },
  {
    platform: "linux",
    arch: "arm64",
    optional: true,
    files: ["linux-arm64.deb", "linux-arm64.AppImage"],
  },
  { platform: "win", arch: "x64", files: ["win-x64.exe"] },
];

function inputs(sha, version) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid release commit.");
  releaseVersion(`v${version}`, version);
}

async function hashes(directory, target, version) {
  const expected = target.files.map((file) => `ardur-${version}-${file}`).sort();
  const actual = (await readdir(directory))
    .filter((file) => /\.(dmg|zip|deb|AppImage|exe)$/.test(file))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected installer set for ${target.platform}-${target.arch}.`);
  }
  const result = {};
  for (const file of expected) {
    result[file] = createHash("sha256")
      .update(await readFile(path.join(directory, file)))
      .digest("hex");
  }
  return result;
}

/** Called only after every install check in this matrix entry succeeded. */
export async function recordAcceptance(directory, output, platform, arch, sha, version) {
  inputs(sha, version);
  const target = INSTALL_TARGETS.find((item) => item.platform === platform && item.arch === arch);
  if (!target) throw new Error("Unknown install target.");
  const artifacts = await hashes(directory, target, version);
  const signing = JSON.parse(
    await readFile(path.join(directory, `install-build-${platform}-${arch}.json`), "utf8"),
  );
  if (typeof signing.signed !== "boolean") throw new Error("Missing build signing decision.");
  const record = {
    schemaVersion: 1,
    platform,
    arch,
    sha,
    version,
    signed: signing.signed,
    artifacts,
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Optional installs may fail, but those exact files must not reach publication. */
export async function filterAccepted(artifactsRoot, receiptsRoot, sha, version) {
  inputs(sha, version);
  const known = new Set(
    INSTALL_TARGETS.map((target) => `desktop-${target.platform}-${target.arch}`),
  );
  for (const directory of await readdir(artifactsRoot)) {
    if (!known.has(directory)) throw new Error("Unknown release artifact directory.");
  }
  const accepted = [];
  for (const target of INSTALL_TARGETS) {
    const id = `${target.platform}-${target.arch}`;
    const directory = path.join(artifactsRoot, `desktop-${id}`);
    let record;
    try {
      record = JSON.parse(await readFile(path.join(receiptsRoot, `${id}.json`), "utf8"));
    } catch (error) {
      if (!target.optional || error.code !== "ENOENT") throw error;
      await rm(directory, { recursive: true, force: true });
      console.error(
        "::warning title=Linux arm64::Optional installers did not pass acceptance and will not be published.",
      );
      continue;
    }
    const actual = await hashes(directory, target, version);
    const signing = JSON.parse(
      await readFile(path.join(directory, `install-build-${id}.json`), "utf8"),
    );
    if (
      record.schemaVersion !== 1 ||
      record.sha !== sha ||
      record.version !== version ||
      record.platform !== target.platform ||
      record.arch !== target.arch ||
      typeof record.signed !== "boolean" ||
      record.signed !== signing.signed ||
      JSON.stringify(record.artifacts) !== JSON.stringify(actual)
    ) {
      throw new Error(`Install receipt does not match the built ${id} artifacts.`);
    }
    accepted.push(record);
  }
  return accepted;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "record") await recordAcceptance(...args);
  else if (command === "filter")
    console.log(JSON.stringify(await filterAccepted(...args), null, 2));
  else throw new Error("Expected record or filter.");
}
