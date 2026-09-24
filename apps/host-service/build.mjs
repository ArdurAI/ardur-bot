import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const adapterRequire = createRequire(
  new URL("../../packages/adapters/package.json", import.meta.url),
);

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
    sourcemap: false,
    metafile: true,
    minify: true,
    define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' },
    logLevel: "warning",
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const entry of output.imports) {
      if (
        !entry.external ||
        (!entry.path.startsWith("node:") && !builtinModules.includes(entry.path))
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
  return { ...result.metafile, native };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const metadata = await bundleHostService();
  process.stdout.write(`Host service: ${Object.values(metadata.outputs)[0].bytes} bytes\n`);
}
