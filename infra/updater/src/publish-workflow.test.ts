import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowText = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/publish-server-image.yml"),
  "utf8",
);
interface WorkflowJob {
  if?: string;
  needs?: string;
  "runs-on"?: string;
  strategy?: { matrix?: { arch?: string[]; include?: Array<Record<string, string>> } };
}

const workflow = parse(workflowText) as {
  jobs: { validate: WorkflowJob; build: WorkflowJob; publish: WorkflowJob };
};

describe("server image publish workflow", () => {
  it("builds every architecture natively instead of emulating arm64", () => {
    expect(workflowText).not.toContain("setup-qemu-action");
    const build = workflow.jobs.build;
    expect(build["runs-on"]).toContain("matrix.runner");
    expect(build.strategy?.matrix?.arch).toEqual(["amd64", "arm64"]);
    const runners = Object.fromEntries(
      (build.strategy?.matrix?.include ?? [])
        .filter((entry) => entry.arch !== undefined)
        .map((entry) => [entry.arch, entry.runner]),
    );
    expect(runners).toEqual({ amd64: "ubuntu-latest", arm64: "ubuntu-24.04-arm" });
  });

  it("publishes one verified multi-arch manifest per image after both builds", () => {
    const publish = workflow.jobs.publish;
    expect(publish.needs).toBe("build");
    expect(workflowText).toContain("push-by-digest=true");
    expect(workflowText).toContain("docker buildx imagetools create");
    expect(workflowText).toContain("for want in linux/amd64 linux/arm64");
    expect(workflowText).toContain("actions/attest-build-provenance@");
  });

  it("publishes Developer as -developer tags on the computer package", () => {
    const build = workflowText.split("\n  build:\n")[1]!.split("\n  publish:\n")[0]!;
    const publish = workflowText.split("\n  publish:\n")[1]!;
    for (const job of [build, publish])
      expect(job).toContain(
        "PACKAGE: ${{ matrix.name == 'computer-developer' && 'computer' || matrix.name }}",
      );
    expect(build).toContain("matrix.name == 'computer-developer' && 'IMAGE_PROFILE=developer'");
    expect(build).toContain("startsWith(matrix.name, 'computer') && 'infra/sandboxes/computer'");
    expect(publish).toContain("SUFFIX: ${{ matrix.name == 'computer-developer' && '-developer'");
    expect(publish).toContain('tag_args+=(-t "${tag}${SUFFIX}")');
    expect(publish).toContain(
      "type=semver,pattern={{version}},enable=${{ startsWith(matrix.name, 'computer') }}",
    );
    // Each publish job downloads only its own image's digests.
    const uploaded = build.match(
      /name: (digest-\$\{\{ matrix\.arch \}\}-\$\{\{ matrix\.name \}\})/,
    )?.[1];
    const pattern = publish.match(/pattern: (digest-\*-\$\{\{ matrix\.name \}\})/)?.[1];
    expect(uploaded && pattern).toBeTruthy();
    const names = ["app", "updater", "computer", "computer-developer"];
    for (const name of names) {
      const glob = new RegExp(
        `^${pattern!.replace("${{ matrix.name }}", name).replace("*", "[^/]*")}$`,
      );
      const matched = names.flatMap((other) =>
        ["amd64", "arm64"]
          .map((arch) =>
            uploaded!.replace("${{ matrix.arch }}", arch).replace("${{ matrix.name }}", other),
          )
          .filter((artifact) => glob.test(artifact)),
      );
      expect(matched, name).toEqual([`digest-amd64-${name}`, `digest-arm64-${name}`]);
    }
  });

  it("keeps pull requests read-only and every action pinned to a commit", () => {
    const validate = workflow.jobs.validate;
    const build = workflow.jobs.build;
    const publish = workflow.jobs.publish;
    expect(validate.if).toBe("github.event_name == 'pull_request'");
    expect(build.if).toBe("github.event_name != 'pull_request'");
    expect(publish.if).toBe("github.event_name != 'pull_request'");
    expect(workflowText).toContain("push: false");
    for (const match of workflowText.matchAll(/uses:\s+([^\s#]+)/g)) {
      expect(match[1], match[1]).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
