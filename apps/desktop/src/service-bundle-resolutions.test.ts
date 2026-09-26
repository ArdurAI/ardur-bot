import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { copyExternals } from "../scripts/bundle-services.mjs";

const loader = fileURLToPath(new URL("../scripts/services-loader.mjs", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writePackage(
  dir: string,
  manifest: { name: string; version: string; dependencies?: Record<string, string> },
  source: string,
) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ ...manifest, main: "index.js" }),
  );
  await writeFile(path.join(dir, "index.js"), source);
}

it("ships each importer the dependency version it declared, through the services loader", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "service-resolutions-"));
  directories.push(root);
  // Installed beside, not above, the shipped copy: Node would otherwise find these first.
  const source = path.join(root, "source");
  const installed = path.join(source, "node_modules");
  // `a` uses the hoisted shared@1; `b` has its own shared@2, as jsdom and data-urls do.
  await writePackage(
    path.join(installed, "a"),
    { name: "a", version: "1.0.0", dependencies: { shared: "^1.0.0" } },
    'module.exports = "a:" + require("shared");',
  );
  await writePackage(
    path.join(installed, "b"),
    { name: "b", version: "1.0.0", dependencies: { shared: "^2.0.0" } },
    'module.exports = "b:" + require("shared") + require("shared/extra");',
  );
  await writePackage(
    path.join(installed, "shared"),
    { name: "shared", version: "1.0.0" },
    'module.exports = "v1";',
  );
  await writePackage(
    path.join(installed, "b", "node_modules", "shared"),
    { name: "shared", version: "2.0.0" },
    'module.exports = "v2";',
  );
  await writeFile(
    path.join(installed, "b", "node_modules", "shared", "extra.js"),
    'module.exports = "+extra2";',
  );
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "fixture" }));

  const services = path.join(root, "services");
  const modules = path.join(services, "modules");
  await mkdir(modules, { recursive: true });
  const resolutions = await copyExternals(["a", "b"], modules, [path.join(source, "package.json")]);
  expect(resolutions).toEqual({ b: { shared: "shared__2.0.0" } });
  expect((await readdir(modules)).sort()).toEqual(["a", "b", "shared", "shared__2.0.0"]);

  await writeFile(path.join(services, "resolutions.json"), JSON.stringify(resolutions));
  await cp(loader, path.join(services, "services-loader.mjs"));
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(services, "services-loader.mjs"),
      "--input-type=module",
      "-e",
      'import a from "a"; import b from "b"; process.stdout.write(a + " " + b);',
    ],
    { cwd: services, encoding: "utf8", env: { PATH: process.env.PATH ?? "", NODE_PATH: modules } },
  );
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("a:v1 b:v2+extra2");
});

it("resolves a shipped package once, without re-entering its own hook", async () => {
  const services = await mkdtemp(path.join(tmpdir(), "service-loader-"));
  directories.push(services);
  await writePackage(
    path.join(services, "modules", "solo"),
    { name: "solo", version: "1.0.0" },
    'module.exports = "solo";',
  );
  await cp(loader, path.join(services, "services-loader.mjs"));
  // Registered after the loader, so it runs first and sees every pass through the hooks.
  await writeFile(
    path.join(services, "count.mjs"),
    'import { registerHooks } from "node:module"; globalThis.passes = 0; registerHooks({ resolve(s, c, next) { if (s === "solo" || s.startsWith("solo/")) globalThis.passes += 1; return next(s, c); } });',
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(services, "services-loader.mjs"),
      "--import",
      path.join(services, "count.mjs"),
      "--input-type=module",
      "-e",
      'import solo from "solo"; process.stdout.write(solo + " " + globalThis.passes);',
    ],
    {
      cwd: services,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NODE_PATH: path.join(services, "modules") },
    },
  );
  // One pass for the import, and one for the loader's own lookup where require.resolve runs
  // hooks too. The old loader recursed until the stack overflowed: hundreds per import.
  const [value, passes] = result.stdout.split(" ");
  expect(value).toBe("solo");
  expect(Number(passes)).toBeGreaterThanOrEqual(1);
  expect(Number(passes)).toBeLessThanOrEqual(2);
});
