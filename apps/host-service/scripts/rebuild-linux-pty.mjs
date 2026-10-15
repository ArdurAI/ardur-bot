import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

// CI only: build on each target's own runner, never on application startup.
if (process.platform !== "linux") throw new Error("Build the Linux PTY on a Linux runner.");
const arch = process.argv[2] ?? process.arch;
if (!["x64", "arm64"].includes(arch) || arch !== process.arch)
  throw new Error("Use the matching Linux release architecture runner.");
const desktop = createRequire(new URL("../../desktop/package.json", import.meta.url));
const host = createRequire(new URL("../package.json", import.meta.url));
const { devDependencies } = desktop("./package.json");
const builder = createRequire(desktop.resolve("electron-builder"));
const nodeGyp = builder.resolve("node-gyp/bin/node-gyp.js");
const root = path.dirname(path.dirname(host.resolve("node-pty")));
const built = spawnSync(
  process.execPath,
  [
    nodeGyp,
    "rebuild",
    `--target=${devDependencies.electron}`,
    `--arch=${arch}`,
    "--dist-url=https://electronjs.org/headers",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, npm_config_runtime: "electron" },
  },
);
if (built.error) throw built.error;
if (built.status !== 0) throw new Error("Linux PTY Electron build failed.");
