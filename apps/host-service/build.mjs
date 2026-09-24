import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
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
  return result.metafile;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const metadata = await bundleHostService();
  process.stdout.write(`Host service: ${Object.values(metadata.outputs)[0].bytes} bytes\n`);
}
