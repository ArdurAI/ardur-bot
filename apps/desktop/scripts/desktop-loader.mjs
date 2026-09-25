import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// Node refuses to strip TypeScript that resolves under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Packaging copies workspace
// packages there, including the SQL migrator. Strip those files before the
// main process evaluates them. Paths outside node_modules keep Node's loader.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.includes("/node_modules/") || !url.endsWith(".ts")) return nextLoad(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      source: stripTypeScriptTypes(source, { mode: "strip" }),
      shortCircuit: true,
    };
  },
});

await import("./main.js");
