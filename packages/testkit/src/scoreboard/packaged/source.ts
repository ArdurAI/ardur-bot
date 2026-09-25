import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { contentDigest } from "../manifest.js";

/** CLI-only source binding, compatible with W0-5. Unit contracts never need git history. */
export async function readSourceBinding(root: string) {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const commit = git(["rev-parse", "HEAD"]).trim();
  const tracked = git(["diff", "--binary", "HEAD"]);
  const names = git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  const untracked = await Promise.all(
    names.map(async (file) => ({
      path: file,
      sha256: createHash("sha256")
        .update(await readFile(path.join(root, file)))
        .digest("hex"),
    })),
  );
  return {
    commit,
    diffDigest: tracked || untracked.length ? contentDigest({ tracked, untracked }) : null,
  };
}
