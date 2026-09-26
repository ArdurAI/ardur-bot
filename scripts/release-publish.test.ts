import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(repo, "scripts/release-publish.mjs");

const WORKFLOW_MARKER = "<!-- ardur-bot-release-desktop-workflow -->";

async function fakeGh(
  mode:
    | "missing"
    | "draft"
    | "foreign-draft"
    | "published"
    | "upload-fails"
    | "edit-fails-published"
    | "edit-fails-draft",
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-publish-"));
  const log = path.join(root, "gh.log");
  const bin = path.join(root, "bin");
  await writeFile(log, "");
  const gh = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
const [command, action] = args;
if (command !== "release") {
  console.error("unexpected command");
  process.exit(1);
}
const views = readFileSync(process.env.GH_LOG, "utf8")
  .split("\\n")
  .filter((line) => line.includes('"view"')).length;
if (action === "view") {
  if (process.env.GH_FIXTURE === "draft") {
    console.log(JSON.stringify({ isDraft: true, body: "${WORKFLOW_MARKER}" }));
    process.exit(0);
  }
  if (process.env.GH_FIXTURE === "foreign-draft") {
    console.log(JSON.stringify({ isDraft: true, body: "a maintainer's hand-written notes" }));
    process.exit(0);
  }
  if (process.env.GH_FIXTURE === "published") {
    console.log(JSON.stringify({ isDraft: false }));
    process.exit(0);
  }
  if (process.env.GH_FIXTURE === "edit-fails-published" || process.env.GH_FIXTURE === "edit-fails-draft") {
    if (views === 1) {
      console.error("release not found");
      process.exit(1);
    }
    console.log(JSON.stringify({ isDraft: process.env.GH_FIXTURE === "edit-fails-draft" }));
    process.exit(0);
  }
  console.error("release not found");
  process.exit(1);
}
if (action === "upload" && process.env.GH_FIXTURE === "upload-fails") process.exit(1);
if (action === "edit" && String(process.env.GH_FIXTURE).startsWith("edit-fails")) process.exit(1);
process.exit(0);
`;
  await import("node:fs/promises").then((fs) => fs.mkdir(bin));
  await writeFile(path.join(bin, "gh"), gh);
  await chmod(path.join(bin, "gh"), 0o755);
  const notes = path.join(root, "notes.md");
  const waiver = path.join(root, "waiver-record.json");
  const installer = path.join(root, "synthetic.dmg");
  await writeFile(notes, "notes\n");
  await writeFile(waiver, '{"reason":"fixture","actor":"release-operator"}\n');
  await writeFile(installer, "bytes");
  return { root, log, bin, notes, waiver, installer, mode };
}

function publish(fixture: Awaited<ReturnType<typeof fakeGh>>) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--tag",
      "v0.1.0-alpha.1",
      "--target",
      "a".repeat(40),
      "--notes",
      fixture.notes,
      "--waiver-record",
      fixture.waiver,
      "--",
      fixture.installer,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        GH_LOG: fixture.log,
        GH_FIXTURE: fixture.mode,
      },
    },
  );
}

async function calls(log: string) {
  const text = await readFile(log, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

describe("release publication retry", () => {
  it("refuses to delete a hand-written draft and leaves it in place", async () => {
    const foreign = await fakeGh("foreign-draft");
    try {
      const blocked = publish(foreign);
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("was not created by this workflow");
      const foreignCalls = await calls(foreign.log);
      expect(foreignCalls.map((item) => item[1])).toEqual(["view"]);
    } finally {
      await rm(foreign.root, { recursive: true, force: true });
    }
  });

  it("deletes a leftover draft and still refuses a published release", async () => {
    const draft = await fakeGh("draft");
    const published = await fakeGh("published");
    const missing = await fakeGh("missing");
    const failed = await fakeGh("upload-fails");
    try {
      const drafted = publish(draft);
      expect(drafted.status).toBe(0);
      const draftedCalls = await calls(draft.log);
      expect(draftedCalls.map((item) => item.slice(0, 2).join(" "))).toEqual([
        "release view",
        "release delete",
        "release create",
        "release upload",
        "release edit",
      ]);
      expect(draftedCalls[1]).toEqual([
        "release",
        "delete",
        "v0.1.0-alpha.1",
        "--yes",
        "--cleanup-tag=false",
      ]);
      expect(draftedCalls[3]).toEqual([
        "release",
        "upload",
        "v0.1.0-alpha.1",
        draft.installer,
        draft.waiver,
      ]);

      const blocked = publish(published);
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("Release already exists");
      expect(await calls(published.log)).toEqual([
        ["release", "view", "v0.1.0-alpha.1", "--json", "isDraft,body"],
      ]);

      expect(publish(missing).status).toBe(0);
      const created = await calls(missing.log);
      expect(created.some((item) => item[1] === "delete")).toBe(false);
      expect(created.map((item) => item[1])).toEqual(["view", "create", "upload", "edit"]);

      expect(publish(failed).status).not.toBe(0);
      const retried = await calls(failed.log);
      expect(retried.map((item) => item[1])).toEqual(["view", "create", "upload", "delete"]);
    } finally {
      await rm(draft.root, { recursive: true, force: true });
      await rm(published.root, { recursive: true, force: true });
      await rm(missing.root, { recursive: true, force: true });
      await rm(failed.root, { recursive: true, force: true });
    }
  });

  it("keeps a published release when the edit fails and still deletes a draft", async () => {
    const published = await fakeGh("edit-fails-published");
    const draft = await fakeGh("edit-fails-draft");
    try {
      const kept = publish(published);
      expect(kept.status).toBe(0);
      expect(kept.stderr.trim()).toBe("warning: the edit reported an error after publishing");
      const keptCalls = await calls(published.log);
      expect(keptCalls.map((item) => item[1])).toEqual([
        "view",
        "create",
        "upload",
        "edit",
        "view",
      ]);
      expect(keptCalls.some((item) => item[1] === "delete")).toBe(false);

      const removed = publish(draft);
      expect(removed.status).not.toBe(0);
      const removedCalls = await calls(draft.log);
      expect(removedCalls.map((item) => item[1])).toEqual([
        "view",
        "create",
        "upload",
        "edit",
        "view",
        "delete",
      ]);
      expect(removedCalls.at(-1)).toEqual([
        "release",
        "delete",
        "v0.1.0-alpha.1",
        "--yes",
        "--cleanup-tag=false",
      ]);
    } finally {
      await rm(published.root, { recursive: true, force: true });
      await rm(draft.root, { recursive: true, force: true });
    }
  });
});
