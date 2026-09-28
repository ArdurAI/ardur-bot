import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Reuse the toolchain already installed for the workspace's host-service build.
const requireFromHostService = createRequire(path.resolve(root, "../host-service/package.json"));
const { build } = requireFromHostService("esbuild");

await build({
  entryPoints: [path.join(root, "src/guided-setup/renderer.tsx")],
  outfile: path.join(root, "dist/guided-setup.js"),
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  nodePaths: [path.resolve(root, "../web/node_modules")],
  alias: {
    "@ardurbot/ui-web/components/guided-setup": path.resolve(
      root,
      "../../packages/ui-web/src/components/guided-setup.tsx",
    ),
  },
  logLevel: "info",
});
