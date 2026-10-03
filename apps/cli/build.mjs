import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/ardur.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
});
