import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitTransport, validateGitRemote } from "@ardurbot/adapters";
import type { BundleFile } from "../../desktop/src/extensions/files.js";
import { bundlePath, validateBundleFiles } from "../../desktop/src/extensions/files.js";

/** Uses the memory transport's isolated Git configuration, with no hooks or checkout filters. */
export async function fetchMarketplaceGit(
  url: string,
  ref = "HEAD",
  sha?: string,
): Promise<BundleFile[]> {
  const remote = validateGitRemote(url);
  if (remote.protocol !== "https") throw new Error("Use an HTTPS marketplace repository URL.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,180}$/.test(ref) || ref.includes(".."))
    throw new Error("The plugin reference is invalid.");
  const root = await mkdtemp(path.join(os.tmpdir(), "ardur-marketplace-"));
  const transport = new GitTransport({ root, remote });
  const signal = AbortSignal.timeout(30_000);
  try {
    await transport.initialize();
    await transport.run(
      [
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        "--no-recurse-submodules",
        "--filter=blob:limit=9000000",
        "--",
        remote.url,
        sha ?? ref,
      ],
      { signal },
    );
    const commit = (
      await transport.run(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], { signal })
    ).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit) || (sha && sha !== commit))
      throw new Error("The plugin commit could not be verified.");
    const tree = await transport.run(["ls-tree", "-r", "-z", "--long", commit], { signal });
    const entries = tree.split("\0").filter(Boolean);
    if (entries.length > 1000) throw new Error("The marketplace contains too many files.");
    let total = 0;
    const inventory = entries.map((entry) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40,64}) +([0-9]+)\t(.+)$/s.exec(entry);
      if (!match) throw new Error("Marketplace links and submodules are not supported.");
      total += Number(match[3]);
      if (total > 9_000_000) throw new Error("The marketplace is too large.");
      return {
        mode: match[1],
        oid: match[2]!,
        path: bundlePath(match[4]!),
        length: Number(match[3]),
      };
    });
    const files: BundleFile[] = [];
    for (const entry of inventory) {
      const bytes = await transport.runBytes(["cat-file", "blob", entry.oid], { signal });
      if (bytes.length !== entry.length)
        throw new Error("The marketplace file changed while reading it.");
      files.push({ path: entry.path, bytes, executable: entry.mode === "100755" });
    }
    validateBundleFiles(files);
    return files;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
