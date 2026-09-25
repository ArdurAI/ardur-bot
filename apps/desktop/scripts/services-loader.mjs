import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ESM bare imports ignore NODE_PATH. The shipped packages live in `modules`,
// not `node_modules`, because electron-builder drops a copied directory with
// that name. Resolve them here, and keep NODE_PATH set for CommonJS require().
const servicesDir = fileURLToPath(new URL("./", import.meta.url));
const modulesDir = path.join(servicesDir, "modules");
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

function shippedUrl(specifier) {
  try {
    const resolved = nodeRequire.resolve(specifier);
    if (!path.isAbsolute(resolved)) return null;
    return pathToFileURL(resolved).href;
  } catch {
    return null;
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!isBare(specifier)) return nextResolve(specifier, context);
    // nextResolve can be called only once, so a shipped package is returned
    // directly instead of retrying the default resolver.
    const shipped = shippedUrl(specifier);
    if (shipped) return { url: shipped, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
