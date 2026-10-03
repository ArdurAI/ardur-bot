import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { branchPreviewVersion, stageBranchPreview } from "./desktop-release.mjs";
import { syncDesktopVersion } from "./desktop-version.mjs";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const builder = createRequire(require.resolve("electron-builder"));
const workflow = builder("js-yaml").load(
  await readFile(new URL("../.github/workflows/release-desktop.yml", import.meta.url), "utf8"),
);

describe("non-publishing desktop dispatch", () => {
  it("builds and accepts x64 macOS natively without extending readiness deadlines", () => {
    for (const job of [workflow.jobs.build, workflow.jobs["install-acceptance"]]) {
      expect(
        job.strategy.matrix.include.find(
          (entry: { platform: string; arch: string }) =>
            entry.platform === "mac" && entry.arch === "x64",
        ).os,
      ).toBe("macos-15-intel");
    }
  });
  it("defaults to no publication and uses the selected ref, not an input tag", () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.publish).toMatchObject({ type: "boolean", default: false, required: false });
    expect(inputs.tag).toBeUndefined();
    const release = workflow.jobs.validate.steps.find(
      (step: { id: string }) => step.id === "release",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal workflow expression.
    expect(release.env.RELEASE_REF).toBe("${{ github.ref }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal workflow expression.
    expect(release.env.RELEASE_TAG).toBe("${{ github.ref_name }}");
    const steps = workflow.jobs.build.steps;
    const preview = steps.findIndex((step: { name: string }) =>
      step.name?.startsWith("Set the branch preview version"),
    );
    const build = steps.findIndex(
      (step: { name: string }) => step.name === "Build renderer and main process",
    );
    expect(preview).toBeGreaterThan(0);
    expect(preview).toBeLessThan(build);
    expect(steps[preview].shell).toBe("bash");
    expect(workflow.jobs.build.if).toBeUndefined();
    expect(workflow.jobs["install-acceptance"].if).toBeUndefined();
  });

  it("runs acceptance scripts from the workflow's own commit and proves it is the validated one", () => {
    const steps = workflow.jobs["install-acceptance"].steps;
    expect(steps[0].uses).toMatch(/^actions\/checkout@/);
    expect(steps[0].with).toEqual({ "persist-credentials": false });
    expect(steps[1]).toMatchObject({
      name: "Require the validated commit",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal workflow expression.
      env: { VALIDATED_SHA: "${{ needs.validate.outputs.sha }}" },
      run: '[[ "$(git rev-parse HEAD)" == "$VALIDATED_SHA" ]]',
    });
  });

  it.each([
    ["push", "refs/tags/v1.2.3", false, true],
    ["workflow_dispatch", "refs/tags/v1.2.3", true, true],
    ["workflow_dispatch", "refs/tags/v1.2.3", false, false],
    ["workflow_dispatch", "refs/heads/feature", false, false],
    ["workflow_dispatch", "refs/heads/feature", true, false],
    ["push", "refs/heads/feature", true, false],
  ])("publication for %s %s publish=%s is %s", (event, ref, publish, allowed) => {
    for (const job of [workflow.jobs.publish, workflow.jobs.evidence]) {
      expect(job.if).toBe(
        "startsWith(github.ref, 'refs/tags/') && (github.event_name == 'push' || inputs.publish == true)",
      );
      expect(
        runInNewContext(job.if, {
          startsWith: (value: string, prefix: string) => value.startsWith(prefix),
          github: { ref, event_name: event },
          inputs: { publish },
        }),
      ).toBe(allowed);
    }
  });

  it("uses a validated synthetic version consistently without changing committed inputs", async () => {
    const sha = "1234567890abcdef".padEnd(40, "a");
    const version = "0.0.0-branch.1234567890ab";
    expect(branchPreviewVersion(sha)).toBe(version);
    for (const bad of [undefined, "1234567", sha.toUpperCase(), `${sha}\n`, `${sha};command`]) {
      expect(() => branchPreviewVersion(bad)).toThrow();
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "branch-version-"));
    try {
      const base = pathToFileURL(`${root}/`);
      await mkdir(path.join(root, "apps/desktop"), { recursive: true });
      await writeFile(path.join(root, "package.json"), '{"name":"fixture","version":"1.2.3"}');
      await writeFile(path.join(root, "apps/desktop/package.json"), '{"version":"1.2.3"}');
      expect(await stageBranchPreview(sha, base)).toBe(version);
      expect(await syncDesktopVersion(base)).toBe(version);
      expect(JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))).toEqual({
        name: "fixture",
        version,
      });
      expect(
        JSON.parse(await readFile(path.join(root, "apps/desktop/package.json"), "utf8")).version,
      ).toBe(version);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("executes the real validate shell for branches and tags without installed dependencies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "branch-dispatch-"));
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      await mkdir(path.join(root, "scripts"));
      await copyFile(
        new URL("./desktop-release.mjs", import.meta.url),
        path.join(root, "scripts/desktop-release.mjs"),
      );
      await writeFile(path.join(root, "package.json"), '{"version":"1.2.3-alpha.1"}');
      git(["init", "-q", "-b", "dev"]);
      git(["add", "package.json", "scripts/desktop-release.mjs"]);
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      ]);
      const sha = git(["rev-parse", "HEAD"]);
      git(["update-ref", "refs/remotes/origin/dev", sha]);
      git(["tag", "v1.2.3-alpha.1"]);
      const step = workflow.jobs.validate.steps.find(
        (entry: { id: string }) => entry.id === "release",
      );
      for (const [event, ref, tag, version] of [
        ["workflow_dispatch", "refs/heads/feature", "feature", branchPreviewVersion(sha)],
        ["push", "refs/tags/v1.2.3-alpha.1", "v1.2.3-alpha.1", "1.2.3-alpha.1"],
        ["workflow_dispatch", "refs/tags/v1.2.3-alpha.1", "v1.2.3-alpha.1", "1.2.3-alpha.1"],
      ]) {
        const output = path.join(root, "output.txt");
        await writeFile(output, "");
        const result = spawnSync("bash", ["-c", step.run], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...env,
            GITHUB_OUTPUT: output,
            RELEASE_EVENT: event,
            RELEASE_REF: ref,
            RELEASE_TAG: tag,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        const receipt = await readFile(output, "utf8");
        expect(receipt).toContain(`sha=${sha}\n`);
        expect(receipt).toContain(`version=${version}\n`);
        expect(receipt).toContain(`tag=${ref.startsWith("refs/tags/") ? tag : ""}\n`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
