import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function releaseVersion(tag, version) {
  if (
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(tag) ||
    tag !== `v${version}`
  ) {
    throw new Error("Release tag must match the root package version.");
  }
  return version;
}

// Only fixed labels and counts leave this process. Subjects, scopes, author identities,
// and file names cannot leak into public release notes.
export async function releaseNotes(subjects, gate) {
  const labels = {
    feat: "Features",
    fix: "Fixes",
    perf: "Performance",
    docs: "Documentation",
    build: "Builds",
    ci: "Automation",
    test: "Tests",
    refactor: "Maintenance",
    chore: "Maintenance",
    style: "Style",
    revert: "Reverts",
  };
  const counts = new Map();
  for (const subject of subjects) {
    const prefix = /^([a-z]+)(?:\([^)]*\))?!?:/.exec(subject)?.[1];
    const label = labels[prefix] ?? "Other changes";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = [
    "Unsigned preview. Signed builds come later.",
    "",
    "macOS updates require downloading and installing the new build manually.",
    "",
    ...[...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, count]) => `- ${label}: ${count} ${count === 1 ? "change" : "changes"}.`),
    "",
  ].join("\n");
  if (gate === undefined) return summary;
  // Loaded only here: the scoreboard needs installed dependencies, and `validate` runs without them.
  const { renderScoreboardNotes } = await import("./scoreboard-index.mjs");
  return `${summary}${renderScoreboardNotes(gate)}`;
}

export async function generateWinget(version, assets, outputDir) {
  releaseVersion(`v${version}`, version);
  await mkdir(outputDir, { recursive: true });
  const exe = await readFile(path.join(assets, `ardur-bot-${version}-win-x64.exe`));
  const sha = createHash("sha256").update(exe).digest("hex");
  for (const file of [
    "ArdurAI.ArdurBot.installer.yaml",
    "ArdurAI.ArdurBot.locale.en-US.yaml",
    "ArdurAI.ArdurBot.yaml",
  ]) {
    let template = await readFile(new URL(`../packaging/winget/${file}`, import.meta.url), "utf8");
    template = template.replace(/@VERSION@/g, version);
    template = template.replace(/@X64_SHA256@/g, sha);
    await writeFile(path.join(outputDir, file), template);
  }
}

export async function generateCask(version, assets, output) {
  releaseVersion(`v${version}`, version);
  let template = await readFile(new URL("../homebrew/Casks/ardur-bot.rb", import.meta.url), "utf8");
  for (const arch of ["arm64", "x64"]) {
    const dmg = await readFile(path.join(assets, `ardur-bot-${version}-mac-${arch}.dmg`));
    template = template.replace(
      `@${arch.toUpperCase()}_SHA256@`,
      createHash("sha256").update(dmg).digest("hex"),
    );
  }
  template = template.replace("@VERSION@", version);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, template);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "validate") {
    const { version } = JSON.parse(await readFile("package.json", "utf8"));
    console.log(releaseVersion(args[0], version));
  } else if (command === "notes") {
    const tag = args[0];
    const evidencePath = args[1];
    if (!tag || !evidencePath) {
      console.error("Publication notes require a validated scoreboard gate file.");
      process.exitCode = 1;
    } else {
      let gate;
      try {
        gate = JSON.parse(await readFile(evidencePath, "utf8"));
      } catch {
        console.error("The scoreboard gate file is missing or unreadable.");
        process.exitCode = 1;
        gate = null;
      }
      if (gate) {
        const git = (values) => execFileSync("git", values, { encoding: "utf8" }).trim();
        let previous;
        try {
          // --first-parent follows only the first parent of a merge, so a tag on a
          // merged side branch is not the previous desktop release.
          // https://git-scm.com/docs/git-describe#Documentation/git-describe.txt---first-parent
          previous = git([
            "describe",
            "--tags",
            "--abbrev=0",
            "--match",
            "v*",
            "--first-parent",
            `${tag}^`,
          ]);
        } catch {
          /* First release includes all ancestors. */
        }
        const subjects = git(["log", "--format=%s", previous ? `${previous}..${tag}` : tag])
          .split("\n")
          .filter(Boolean);
        process.stdout.write(await releaseNotes(subjects, gate));
      }
    }
  } else if (command === "cask") {
    await generateCask(args[0], args[1], args[2]);
  } else throw new Error("Expected validate, notes, or cask.");
}
