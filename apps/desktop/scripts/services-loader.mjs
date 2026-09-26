import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ESM bare imports ignore NODE_PATH. The shipped packages live in `modules`,
// not `node_modules`, because electron-builder drops a copied directory with
// that name. Resolve them here, and keep NODE_PATH set for CommonJS require().
// The hooks also run for require(), so a package that needs a second version of
// a dependency gets it from `resolutions.json` (written by bundle-services.mjs).
const servicesDir = fileURLToPath(new URL("./", import.meta.url));
const modulesDir = path.join(servicesDir, "modules");
const resolutions = (() => {
  try {
    return JSON.parse(readFileSync(path.join(servicesDir, "resolutions.json"), "utf8"));
  } catch {
    return {};
  }
})();
const nodeRequire = createRequire(path.join(servicesDir, "api.mjs"));
const current = process.env.NODE_PATH?.split(path.delimiter).filter(Boolean) ?? [];
if (!current.includes(modulesDir)) {
  process.env.NODE_PATH = [modulesDir, ...current].join(path.delimiter);
  const nodeModule = nodeRequire("node:module");
  (nodeModule.Module?._initPaths ?? nodeModule._initPaths)?.();
}

function isBare(specifier) {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("#") &&
    !specifier.startsWith("node:") &&
    !specifier.startsWith("file:") &&
    !specifier.startsWith("data:")
  );
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The copied package a file belongs to: `modules/<dir>/...`, with scoped dirs two deep. */
function importerOf(parentURL) {
  if (!parentURL?.startsWith("file:")) return null;
  const relative = path.relative(modulesDir, fileURLToPath(parentURL));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return packageName(relative.split(path.sep).join("/"));
}

/** `whatwg-url/x` becomes `whatwg-url__17.1.0/x` for an importer that needs that copy. */
function forImporter(specifier, parentURL) {
  const name = packageName(specifier);
  const copy = resolutions[importerOf(parentURL)]?.[name];
  return copy ? copy + specifier.slice(name.length) : specifier;
}

function shippedUrl(specifier) {
  try {
    const resolved = nodeRequire.resolve(specifier);
    if (!path.isAbsolute(resolved)) return null;
    return pathToFileURL(resolved).href;
  } catch {
    return null;
  }
}

/** `nodeRequire.resolve` runs these hooks too; inside one, it must use the default resolver. */
let resolving = false;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (resolving || !isBare(specifier)) return nextResolve(specifier, context);
    // nextResolve can be called only once, so a shipped package is returned
    // directly instead of retrying the default resolver.
    resolving = true;
    let shipped;
    try {
      shipped = shippedUrl(forImporter(specifier, context.parentURL));
    } finally {
      resolving = false;
    }
    if (shipped) return { url: shipped, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
