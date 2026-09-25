import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { encodedBundle, uploadedBundle } from "./customization-files.js";

it("loads shared bundle validation in a plain JavaScript runtime", async () => {
  await promisify(execFile)(
    process.execPath,
    [
      "--no-experimental-strip-types",
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
     import { validateBundleFiles } from "@ardurbot/contracts/bundles/files";
     import { parseMcpbManifest } from "@ardurbot/contracts/bundles/manifest";
     import { planPlugin } from "@ardurbot/contracts/bundles/plugins";
     import { readBundleZip } from "@ardurbot/contracts/bundles/zip";
     assert.throws(() => validateBundleFiles([{ path: "../escape", bytes: new Uint8Array() }]));
     assert.throws(() => parseMcpbManifest({}));
     assert.throws(() => readBundleZip(new Uint8Array()));
     const files = [{ path: ".claude-plugin/plugin.json", bytes: Buffer.from('{"name":"fixture"}') }];
     assert.equal(planPlugin(files).name, "fixture");`,
    ],
    { cwd: fileURLToPath(new URL("../", import.meta.url)) },
  );
});

it("keeps API bundle imports within package boundaries and its source root", async () => {
  const directory = new URL("./", import.meta.url);
  const sources = await Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith(".ts"))
      .map(async (name) => ({
        name,
        source: await readFile(new URL(name, directory), "utf8"),
      })),
  );
  expect(
    sources
      .filter(({ source }) => /from\s+["'][^"']*\.\.\/.*desktop\//.test(source))
      .map(({ name }) => name),
  ).toEqual([]);
  const config = JSON.parse(await readFile(new URL("../tsconfig.json", directory), "utf8"));
  expect(config.compilerOptions.rootDir).toBe("src");
});

it("validates uploads with the same portable bundle rules as native installation", () => {
  const files = [
    { path: "skills/check/SKILL.md", bytes: Buffer.from("Recipe"), executable: false },
  ];
  expect(uploadedBundle(encodedBundle(files))).toEqual(files);
  for (const path of ["../escape", "a/CON.txt", "a\\escape", "/absolute"])
    expect(() => uploadedBundle([{ path, content: "eA==" }])).toThrow("unsafe");
  expect(() => uploadedBundle([{ path: "file", content: "invalid-base64" }])).toThrow("base64");
});
