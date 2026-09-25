import { existsSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Packages the API and worker as ESM bundles. Top-level await in the API entry
 * stays legal. The generated Prisma client is compiled into the bundles; its
 * query compiler is WASM loaded through `@prisma/client` package exports and
 * `import.meta.url`, so that runtime stays on disk. Native addons stay on disk
 * for the same reason.
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const servicesDir = path.join(desktopDir, "build", "services");
const esbuildRequire = createRequire(
  fileURLToPath(new URL("../../host-service/package.json", import.meta.url)),
);

export const PRISMA_RUNTIME_FILES = [
  "modules/@prisma/client/runtime/client.js",
  "modules/@prisma/client/runtime/client.mjs",
  "modules/@prisma/client/runtime/query_compiler_fast_bg.postgresql.mjs",
  "modules/@prisma/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.mjs",
];

const PRISMA_CLIENT_FILES = [
  "package.json",
  "runtime/client.js",
  "runtime/client.mjs",
  "runtime/query_compiler_fast_bg.postgresql.mjs",
  "runtime/query_compiler_fast_bg.postgresql.wasm-base64.mjs",
];

export function serviceBundlePlan() {
  return {
    entries: ["api.mjs", "worker.mjs"],
    loader: "services-loader.mjs",
    prismaRuntime: PRISMA_RUNTIME_FILES,
    extraResource: { from: "build/services", to: "services" },
    format: "esm",
    platform: "node",
    target: "node22",
  };
}

function isExternalSpecifier(specifier) {
  return (
    specifier === "koffi" ||
    specifier === "pg-native" ||
    specifier === "sharp" ||
    specifier === "jsdom" ||
    specifier.startsWith("jsdom/") ||
    specifier === "@prisma/client" ||
    specifier === "@prisma/client-runtime-utils" ||
    specifier.startsWith("@prisma/client/") ||
    specifier.startsWith("@koromix/") ||
    specifier.startsWith("@img/") ||
    specifier.endsWith(".node")
  );
}

function packageName(specifier) {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return `${scope}/${name}`;
  }
  return specifier.split("/")[0];
}

const requireFrom = [
  fileURLToPath(new URL("../../../packages/db/package.json", import.meta.url)),
  fileURLToPath(new URL("../../../packages/adapters/package.json", import.meta.url)),
  fileURLToPath(new URL("../../api/package.json", import.meta.url)),
  fileURLToPath(new URL("../../worker/package.json", import.meta.url)),
  fileURLToPath(new URL("../package.json", import.meta.url)),
];

function packageRootFromEntry(entry, name) {
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    const manifestPath = path.join(dir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === name) return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function resolveFrom(origin, name) {
  const require = createRequire(origin);
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      throw error;
    }
    try {
      const root = packageRootFromEntry(require.resolve(name), name);
      if (root) return root;
    } catch (inner) {
      if (inner?.code !== "MODULE_NOT_FOUND" && inner?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
        throw inner;
      }
    }
  }
  // Some native packages ship no "exports" main. Node can still load them by
  // path from the depending package's own node_modules. Scoped packages sit one
  // directory deeper than unscoped ones.
  const packageDir = path.dirname(origin);
  const parent = path.dirname(packageDir);
  const nodeModules = path.basename(parent).startsWith("@") ? path.dirname(parent) : parent;
  const sibling = path.join(nodeModules, ...name.split("/"));
  if (existsSync(path.join(sibling, "package.json"))) return realpathSync(sibling);
  return null;
}

function resolvePackageRoot(name, origin) {
  const origins = origin ? [origin, ...requireFrom] : requireFrom;
  for (const candidate of origins) {
    const root = resolveFrom(candidate, name);
    if (root) return root;
  }
  return null;
}

async function copyPackageContents(name, source, destinationRoot) {
  const destination = path.join(destinationRoot, name);
  if (name === "@prisma/client") {
    for (const relative of PRISMA_CLIENT_FILES) {
      const target = path.join(destination, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(source, relative), target);
    }
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: false,
    filter(candidate) {
      const relative = path.relative(source, candidate);
      return !relative.split(path.sep).includes("node_modules");
    },
  });
}

const REQUIRED_EXTERNALS = new Set(["@prisma/client", "@prisma/client-runtime-utils", "koffi"]);

async function copyExternal(name, destinationRoot, seen, origin) {
  if (seen.has(name)) return;
  seen.add(name);
  const source = resolvePackageRoot(name, origin);
  if (!source) {
    if (REQUIRED_EXTERNALS.has(name)) {
      throw new Error(`Cannot find the package to ship beside the service bundles: ${name}`);
    }
    if (!origin) {
      process.stdout.write(
        `Service bundles: skipped optional package ${name}; it is not installed.\n`,
      );
    }
    return;
  }
  await copyPackageContents(name, realpathSync(source), destinationRoot);
  const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  };
  const nextOrigin = path.join(source, "package.json");
  for (const dependency of Object.keys(dependencies)) {
    await copyExternal(dependency, destinationRoot, seen, nextOrigin);
  }
}

export async function bundleServices() {
  const generated = fileURLToPath(
    new URL("../../../packages/db/src/generated/prisma/client.ts", import.meta.url),
  );
  try {
    await stat(generated);
  } catch {
    throw new Error("Run pnpm db:generate before bundling the API and worker.");
  }
  const { build } = esbuildRequire("esbuild");
  const plan = serviceBundlePlan();
  await rm(servicesDir, { recursive: true, force: true });
  await mkdir(servicesDir, { recursive: true });
  const externals = new Set();
  const entries = [
    ["apps/api/src/index.ts", "api.mjs"],
    ["apps/worker/src/index.ts", "worker.mjs"],
  ];
  for (const [entry, outfile] of entries) {
    const result = await build({
      absWorkingDir: repoRoot,
      entryPoints: [entry],
      outfile: path.join(servicesDir, outfile),
      bundle: true,
      format: plan.format,
      platform: plan.platform,
      target: plan.target,
      packages: "bundle",
      sourcemap: false,
      metafile: true,
      banner: {
        js: 'import { createRequire as __ardurCreateRequire } from "node:module"; const require = __ardurCreateRequire(import.meta.url);',
      },
      define: {
        "process.env.WS_NO_BUFFER_UTIL": '"1"',
        "process.env.WS_NO_UTF_8_VALIDATE": '"1"',
      },
      plugins: [
        {
          name: "service-externals",
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /.*/ }, (args) => {
              if (!isExternalSpecifier(args.path)) return undefined;
              return { path: args.path, external: true };
            });
          },
        },
      ],
      logLevel: "warning",
    });
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imported of output.imports) {
        if (!imported.external) continue;
        if (imported.path.startsWith("node:")) continue;
        if (builtinModules.includes(imported.path)) continue;
        externals.add(packageName(imported.path));
      }
    }
  }
  const modulesDir = path.join(servicesDir, "modules");
  await mkdir(modulesDir, { recursive: true });
  const seen = new Set();
  for (const name of externals) {
    await copyExternal(name, modulesDir, seen);
  }
  for (const relative of PRISMA_RUNTIME_FILES) {
    await stat(path.join(servicesDir, relative));
  }
  const koffiPackage = `@koromix/koffi-${process.platform}-${process.arch}`;
  await stat(path.join(modulesDir, koffiPackage, "package.json"));
  await cp(
    fileURLToPath(new URL("./services-loader.mjs", import.meta.url)),
    path.join(servicesDir, plan.loader),
  );
  return { servicesDir, externals: [...externals].sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const staged = await bundleServices();
  process.stdout.write(
    `Service bundles staged with ${staged.externals.join(", ")} at ${staged.servicesDir}\n`,
  );
}
