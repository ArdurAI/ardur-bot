import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { generateCask, releaseNotes, releaseVersion } from "./desktop-release.mjs";
import { syncDesktopVersion } from "./desktop-version.mjs";

describe("release metadata", () => {
  it("accepts a preview matching the root version and rejects mismatched or unsafe refs", () => {
    expect(releaseVersion("v0.1.0-alpha.1", "0.1.0-alpha.1")).toBe("0.1.0-alpha.1");
    for (const tag of ["dev", "v0.2.0", "v0.1.0;echo", "v0.1.0/other"])
      expect(() => releaseVersion(tag, "0.1.0")).toThrow();
  });
  it("validates a tag with no installed dependencies, as the release workflow runs it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "release-validate-"));
    try {
      await mkdir(path.join(dir, "scripts"));
      for (const name of ["desktop-release.mjs", "scoreboard-index.mjs"])
        await copyFile(
          fileURLToPath(new URL(`./${name}`, import.meta.url)),
          path.join(dir, "scripts", name),
        );
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3-alpha.1" }));
      const env = { ...process.env };
      delete env.NODE_PATH;
      delete env.NODE_OPTIONS;
      const run = (tag: string) =>
        spawnSync(process.execPath, ["scripts/desktop-release.mjs", "validate", tag], {
          cwd: dir,
          encoding: "utf8",
          env,
        });
      const valid = run("v1.2.3-alpha.1");
      expect(valid.stderr).toBe("");
      expect(valid.status).toBe(0);
      expect(valid.stdout).toBe("1.2.3-alpha.1\n");
      expect(run("v9.9.9").status).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("groups conventional prefixes without publishing subjects, scopes, or identities", async () => {
    const notes = await releaseNotes([
      "feat(private/fixture): Fixture Person changed a secret",
      "fix: sensitive@example.invalid",
      "perf: /private/fixture",
      "unconventional subject",
    ]);
    expect(notes).toContain("Features: 1 change");
    expect(notes).toContain("Fixes: 1 change");
    expect(notes).toContain("Performance: 1 change");
    expect(notes).not.toMatch(/Person|private|fixture|sensitive|unconventional/);
  });
  it("derives the desktop version and both cask checksums from build inputs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "release-fixture-"));
    try {
      await mkdir(path.join(dir, "apps/desktop"), { recursive: true });
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3-alpha.1" }));
      await writeFile(
        path.join(dir, "apps/desktop/package.json"),
        JSON.stringify({ version: "0.0.0", name: "fixture" }),
      );
      expect(await syncDesktopVersion(pathToFileURL(`${dir}/`))).toBe("1.2.3-alpha.1");
      expect(
        JSON.parse(await readFile(path.join(dir, "apps/desktop/package.json"), "utf8")).version,
      ).toBe("1.2.3-alpha.1");
      for (const arch of ["arm64", "x64"])
        await writeFile(path.join(dir, `ardur-bot-1.2.3-alpha.1-mac-${arch}.dmg`), arch);
      await generateCask("1.2.3-alpha.1", dir, path.join(dir, "Casks/ardur-bot.rb"));
      const cask = await readFile(path.join(dir, "Casks/ardur-bot.rb"), "utf8");
      expect(cask).toContain('version "1.2.3-alpha.1"');
      for (const arch of ["arm64", "x64"])
        expect(cask).toContain(createHash("sha256").update(arch).digest("hex"));
      expect(cask).not.toContain("@VERSION@");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the first-parent tag when a merged side branch tag is closer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "release-notes-"));
    const git = (args: string[], date = "2026-09-01T00:00:00Z") => {
      const result = spawnSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Release Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Release Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    const commit = async (file: string, message: string) => {
      await writeFile(path.join(root, file), `${file}\n`);
      git(["add", file]);
      git(["commit", "-q", "-m", message]);
    };
    try {
      git(["init", "-q", "-b", "dev"]);
      await commit("base", "fix: base");
      git(["tag", "v1.0.0"]);
      await commit("mainline", "perf: mainline");
      git(["checkout", "-q", "-b", "side"]);
      await commit("side", "feat: side");
      git(["tag", "v9.0.0"]);
      git(["checkout", "-q", "dev"]);
      git(["merge", "--no-ff", "-q", "-m", "merge side", "side"]);
      await commit("shipped", "fix: shipped");
      git(["tag", "v1.1.0"]);
      const gate = {
        schemaVersion: 5,
        path: "waiver",
        allowPublication: true,
        exitCode: 0,
        reasons: [],
        waiver: { reason: "Physical runners are not provisioned" },
        distributedDigests: [],
      };
      const gatePath = path.join(root, "gate.json");
      await writeFile(gatePath, JSON.stringify(gate));
      const notes = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./desktop-release.mjs", import.meta.url)),
          "notes",
          "v1.1.0",
          gatePath,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: os.devNull,
            GIT_CONFIG_NOSYSTEM: "1",
          },
        },
      );
      expect(notes.stderr).toBe("");
      expect(notes.status).toBe(0);
      expect(notes.stdout).toContain(
        "This preview was published without measured performance evidence: Physical runners are not provisioned.\n",
      );
      expect(notes.stdout).toContain("- Features: 1 change.");
      expect(notes.stdout).toContain("- Performance: 1 change.");
      expect(notes.stdout).toContain("- Fixes: 1 change.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not require Docker in the README install section", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const installSectionMatch = readme.match(
      /## Install a desktop preview\n([\s\S]*?)## Run from source/,
    );
    if (!installSectionMatch?.[1]) {
      throw new Error("Could not find the 'Install a desktop preview' section in README.md");
    }
    const installSection = installSectionMatch[1];
    expect(installSection.toLowerCase()).not.toContain("requires docker");
    expect(installSection.toLowerCase()).not.toContain("docker desktop");
  });
});
