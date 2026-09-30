import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  filterAccepted,
  INSTALL_TARGETS,
  recordAcceptance,
} from "./release/install-acceptance-record.mjs";

const sha = "a".repeat(40);
const version = "1.2.3-alpha.1";
const temporary: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "install-receipts-"));
  temporary.push(root);
  const artifacts = path.join(root, "artifacts");
  const receipts = path.join(root, "receipts");
  await mkdir(receipts);
  for (const target of INSTALL_TARGETS) {
    const id = `${target.platform}-${target.arch}`;
    const directory = path.join(artifacts, `desktop-${id}`);
    await mkdir(directory, { recursive: true });
    for (const file of target.files) {
      await writeFile(
        path.join(directory, `ardur-${version}-${file}`),
        `fixture installer ${file}`,
      );
    }
    await writeFile(path.join(directory, `install-build-${id}.json`), '{"signed":false}\n');
    await recordAcceptance(
      directory,
      path.join(receipts, `${id}.json`),
      target.platform,
      target.arch,
      sha,
      version,
    );
  }
  return { root, artifacts, receipts };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("publication install receipts", () => {
  it("accepts the exact built files for every platform", async () => {
    const { artifacts, receipts } = await fixture();
    expect(await filterAccepted(artifacts, receipts, sha, version)).toHaveLength(5);
  });

  it("removes optional installers without a success receipt", async () => {
    const { artifacts, receipts } = await fixture();
    await rm(path.join(receipts, "linux-arm64.json"));
    expect(await filterAccepted(artifacts, receipts, sha, version)).toHaveLength(4);
    expect(await readdir(artifacts)).not.toContain("desktop-linux-arm64");
  });

  it("refuses missing required receipts", async () => {
    const { artifacts, receipts } = await fixture();
    await rm(path.join(receipts, "mac-x64.json"));
    await expect(filterAccepted(artifacts, receipts, sha, version)).rejects.toThrow();
  });

  it.each(["hash", "sha", "version", "signed", "extra", "corrupt-optional"])(
    "refuses %s mismatch instead of treating tampered artifacts as accepted",
    async (mutation) => {
      const { artifacts, receipts } = await fixture();
      const directory = path.join(artifacts, "desktop-mac-arm64");
      if (mutation === "hash") {
        await writeFile(path.join(directory, `ardur-${version}-mac-arm64.dmg`), "changed fixture");
      } else if (mutation === "extra") {
        await writeFile(path.join(directory, "unverified.dmg"), "extra fixture");
      } else if (mutation === "corrupt-optional") {
        await writeFile(path.join(receipts, "linux-arm64.json"), "not json");
      } else {
        const file = path.join(receipts, "mac-arm64.json");
        const record = JSON.parse(await readFile(file, "utf8"));
        record[mutation] = mutation === "signed" ? true : "wrong";
        await writeFile(file, JSON.stringify(record));
      }
      await expect(filterAccepted(artifacts, receipts, sha, version)).rejects.toThrow();
    },
  );

  it("matches the build matrix and gates both evidence and publishing", async () => {
    const require = createRequire(import.meta.url);
    const builder = createRequire(require.resolve("electron-builder", { paths: ["apps/desktop"] }));
    const yaml = builder("js-yaml");
    const workflow = yaml.load(
      await readFile(new URL("../.github/workflows/release-desktop.yml", import.meta.url), "utf8"),
    );
    const build = workflow.jobs.build.strategy.matrix.include;
    const acceptance = workflow.jobs["install-acceptance"];
    const key = (entry: { platform: string; arch: string; optional?: boolean }) =>
      `${entry.platform}-${entry.arch}:${entry.optional ?? false}`;
    expect(acceptance.strategy.matrix.include.map(key).sort()).toEqual(build.map(key).sort());
    expect(INSTALL_TARGETS.map(key).sort()).toEqual(build.map(key).sort());
    expect(acceptance.needs).toContain("build");
    expect(workflow.jobs.publish.needs).toContain("install-acceptance");
    expect(workflow.jobs.evidence.needs).toContain("install-acceptance");
    expect(acceptance["continue-on-error"]).toBe(workflow.jobs.build["continue-on-error"]);
    const upload = acceptance.steps.find(
      (step: { name: string }) => step.name === "Upload install logs and screenshots",
    );
    expect(upload.if).toBe("always()");
    const record = acceptance.steps.find(
      (step: { name: string }) => step.name === "Record accepted installer hashes",
    );
    expect(record.if).toBeUndefined();
    const performance = yaml.load(
      await readFile(new URL("../.github/workflows/performance.yml", import.meta.url), "utf8"),
    );
    const assembly = performance.jobs["release-gate"].steps.find(
      (step: { name: string }) =>
        step.name === "Assemble the exact publication files before gating",
    ).run;
    expect(assembly.indexOf("install-acceptance-record.mjs filter")).toBeLessThan(
      assembly.indexOf("desktop-release-assets.mjs"),
    );
  });
});
