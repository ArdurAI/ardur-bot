import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Certificate builds must cover the executable helper as well as the addon. */
export default function verifyMacPtySignatures(context, run = execFileSync) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const native = path.join(app, "Contents", "Resources", "host-service", "native");
  const targets = readdirSync(native).filter((name) => /^mac_(arm64|x64)$/.test(name));
  if (targets.length !== 1) throw new Error("Expected exactly one packaged macOS PTY target.");
  const target = targets[0];
  const arch = target.slice("mac_".length);
  const binaries = path.join(native, target, "node-pty", "prebuilds", `darwin-${arch}`);
  for (const name of ["pty.node", "spawn-helper"]) {
    const file = path.join(binaries, name);
    if (!statSync(file).isFile()) throw new Error("Missing packaged macOS PTY binary.");
    if (name === "spawn-helper" && !(statSync(file).mode & 0o111))
      throw new Error("Packaged macOS PTY helper is not executable.");
    run("codesign", ["--verify", "--strict", file], { stdio: "inherit" });
  }
  run("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
}
