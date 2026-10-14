import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { smokeDarwinPty } from "./scripts/smoke-darwin-pty.mjs";

const adapterRequire = createRequire(
  new URL("../../packages/adapters/package.json", import.meta.url),
);
const hostRequire = createRequire(new URL("./package.json", import.meta.url));

export async function stageDarwinPty(directory, ptyEntry = hostRequire.resolve("node-pty")) {
  const root = path.dirname(path.dirname(ptyEntry));
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (manifest.version !== "1.1.0") throw new Error("Expected the pinned node-pty 1.1.0 runtime.");
  const files = [];
  for (const arch of ["arm64", "x64"]) {
    const relative = `native/mac_${arch}/node-pty`;
    const target = path.join(directory, relative);
    await rm(path.dirname(target), { recursive: true, force: true });
    await mkdir(path.join(target, "lib"), { recursive: true });
    const prebuild = `prebuilds/darwin-${arch}`;
    await mkdir(path.join(target, prebuild), { recursive: true });
    // Preserve upstream's relative addon/helper lookup; no install-time loader,
    // development dependencies, sources, tests or other platforms are shipped.
    for (const name of ["index", "unixTerminal", "terminal", "eventEmitter2", "utils"]) {
      const file = `lib/${name}.js`;
      await copyFile(path.join(root, file), path.join(target, file));
      files.push(`${relative}/${file}`);
    }
    for (const name of ["pty.node", "spawn-helper"]) {
      const file = `${prebuild}/${name}`;
      await copyFile(path.join(root, file), path.join(target, file));
      if (name === "spawn-helper") await chmod(path.join(target, file), 0o755);
      files.push(`${relative}/${file}`);
    }
    await copyFile(path.join(root, "LICENSE"), path.join(target, "LICENSE"));
    await writeFile(
      path.join(target, "package.json"),
      `${JSON.stringify({
        name: "node-pty",
        version: manifest.version,
        main: "lib/index.js",
        license: "MIT",
      })}\n`,
    );
    files.push(`${relative}/LICENSE`, `${relative}/package.json`);
  }
  return { files };
}

export async function stageWindowsNativeAddons(
  directory,
  koffiEntry = adapterRequire.resolve("koffi"),
) {
  const nativeRoot = path.join(directory, "native");
  // A rebuild must not retain a binary from a previous dependency install or target.
  await rm(nativeRoot, { recursive: true, force: true });
  const requireKoffi = createRequire(koffiEntry);
  const files = [];
  const skipped = [];
  // Stage installed Windows targets only. electron-builder selects ${os}_${arch}.
  for (const arch of ["x64", "arm64", "ia32"]) {
    const target = `win32_${arch}`;
    const packageBinary = `@koromix/koffi-win32-${arch}/${target}/koffi.node`;
    let source;
    try {
      source = requireKoffi.resolve(packageBinary);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
    // require.resolve can cache a path whose optional package was since removed.
    if (!source || !existsSync(source)) {
      // Koffi also supports a local prebuild at build/koffi/<platform>_<arch>.
      const local = path.join(path.dirname(koffiEntry), "build", "koffi", target, "koffi.node");
      source = existsSync(local) ? local : undefined;
    }
    if (!source) {
      const reason = `Neither ${packageBinary} nor koffi/build/koffi/${target}/koffi.node is installed; Windows writes remain refused for this target.`;
      skipped.push({ target, reason });
      process.stdout.write(`Host service native: skipped ${target}. ${reason}\n`);
      continue;
    }
    const relative = `native/win_${arch}/koffi.node`;
    const destination = path.join(directory, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    files.push(relative);
    process.stdout.write(`Host service native: staged ${target} at ${relative}.\n`);
  }
  return { files, skipped };
}

export async function bundleHostService(
  outfile = fileURLToPath(new URL("./dist/host-service.cjs", import.meta.url)),
) {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("../..", import.meta.url)),
    entryPoints: ["apps/host-service/src/index.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    packages: "bundle",
    external: ["node-pty"],
    // ESM source uses its module URL in tsx; the relocatable CJS artifact uses
    // its own URL, never a build-machine path or esbuild's empty import.meta.
    banner: {
      js: 'const hostServiceModuleUrl = require("node:url").pathToFileURL(__filename).href;',
    },
    sourcemap: false,
    metafile: true,
    minify: true,
    define: {
      "process.env.WS_NO_BUFFER_UTIL": '"1"',
      "process.env.WS_NO_UTF_8_VALIDATE": '"1"',
      "import.meta.url": "hostServiceModuleUrl",
    },
    logLevel: "warning",
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const entry of output.imports) {
      if (
        !entry.external ||
        (entry.path !== "node-pty" &&
          !entry.path.startsWith("node:") &&
          !builtinModules.includes(entry.path))
      )
        throw new Error(`Host bundle has a runtime dependency: ${entry.path}`);
    }
  }
  if (Object.keys(result.metafile.outputs).length !== 1)
    throw new Error("Host bundle must be one file.");
  if (
    Object.keys(result.metafile.inputs).some((name) =>
      /(?:prisma|pi-runtime|pi-ai|koffi)/i.test(name),
    )
  )
    throw new Error("Host bundle includes a server or native-addon dependency.");
  const native = await stageWindowsNativeAddons(path.dirname(outfile));
  const pty = await stageDarwinPty(path.dirname(outfile));
  const python = path.join(path.dirname(outfile), "python");
  await mkdir(python, { recursive: true });
  for (const name of [
    "hermes_launcher.py",
    "hermes_profile.py",
    "hermes_sources.json",
    "hermes_compat.json",
    "runtime_config_profile.json",
  ])
    await copyFile(
      fileURLToPath(new URL(`../../packages/host-runtime/python/${name}`, import.meta.url)),
      path.join(python, name),
    );
  await smokeDarwinPty(path.dirname(outfile));
  return { ...result.metafile, native: { ...native, files: [...native.files, ...pty.files] } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const metadata = await bundleHostService();
  process.stdout.write(`Host service: ${Object.values(metadata.outputs)[0].bytes} bytes\n`);
}
