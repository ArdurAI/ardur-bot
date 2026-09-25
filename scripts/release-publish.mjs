import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.error) fail(result.error.message);
  return result;
}

function parse(argv) {
  const separator = argv.indexOf("--");
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const files = separator === -1 ? [] : argv.slice(separator + 1);
  const args = {};
  for (let index = 0; index < flags.length; index += 1) {
    const key = flags[index];
    const value = flags[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--"))
      fail("invalid-argument");
    args[key.slice(2)] = value;
    index += 1;
  }
  return { ...args, files };
}

function propagate(result) {
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status == null || result.status === 0 ? 1 : result.status);
}

const args = parse(process.argv.slice(2));
const { tag, target, notes, files } = args;
const waiver = args["waiver-record"];
if (!tag || !/^[a-f0-9]{40}$/.test(target ?? "") || !notes || files.length === 0)
  fail("invalid-argument");

const view = gh(["release", "view", tag, "--json", "isDraft"]);
let createdDraft = false;
if (view.status === 0) {
  let parsed;
  try {
    parsed = JSON.parse(view.stdout);
  } catch {
    fail("Release lookup failed.");
  }
  if (parsed.isDraft === true) {
    const deleted = gh(["release", "delete", tag, "--yes", "--cleanup-tag=false"]);
    if (deleted.status !== 0) propagate(deleted);
  } else {
    fail("Release already exists; refusing to replace its assets.");
  }
} else if (!/not found/i.test(`${view.stderr ?? ""}${view.stdout ?? ""}`)) {
  propagate(view);
}

const created = gh([
  "release",
  "create",
  tag,
  "--verify-tag",
  "--target",
  target,
  "--draft",
  "--prerelease",
  "--latest=false",
  "--title",
  tag,
  "--notes-file",
  notes,
]);
if (created.status !== 0) propagate(created);
createdDraft = true;

const uploadArgs = ["release", "upload", tag, ...files];
if (typeof waiver === "string" && waiver !== "" && existsSync(waiver)) uploadArgs.push(waiver);
const uploaded = gh(uploadArgs);
if (uploaded.status !== 0) {
  if (createdDraft) gh(["release", "delete", tag, "--yes", "--cleanup-tag=false"]);
  propagate(uploaded);
}

const edited = gh(["release", "edit", tag, "--draft=false", "--prerelease", "--latest=false"]);
if (edited.status !== 0) {
  if (createdDraft) {
    const again = gh(["release", "view", tag, "--json", "isDraft"]);
    let published = false;
    let draft = false;
    if (again.status === 0) {
      try {
        const parsed = JSON.parse(again.stdout);
        published = parsed.isDraft === false;
        draft = parsed.isDraft === true;
      } catch {
        published = false;
        draft = false;
      }
    }
    if (draft) gh(["release", "delete", tag, "--yes", "--cleanup-tag=false"]);
    if (published) {
      process.stderr.write("warning: the edit reported an error after publishing\n");
      process.exit(0);
    }
  }
  propagate(edited);
}
