import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
// Repository-wide reads include binary assets and share I/O with other test workers.
const sourceScanTimeout = 120_000;
const fork = { commit: "59d4f0c2", date: "2026-09-23" };
// The upstream maintainer's company site. Assemble it so this test does not match itself.
const maintainerSite = ["getinboxzero", "com"].join(".");

type Upstream = { name: string; source: string; owner: string };
type Term = { label: string; value: string };
type Reference = { path: string; line: number | null; label: string };
type AllowlistEntry = { card: string; path: string; label: string; lines: number };

// Temporary, card B16-1: the marketing website still links the upstream maintainer's company
// until the owner confirms who operates the site. Each entry allows exactly this many matching
// lines in one file; remove it together with the fix.
const temporaryAllowlist: AllowlistEntry[] = [
  { card: "B16-1", path: "apps/www/src/site.ts", label: "upstream maintainer site", lines: 1 },
  {
    card: "B16-1",
    path: "apps/www/src/components/HomePage.astro",
    label: "upstream maintainer site",
    lines: 1,
  },
];

function readText(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

// NOTICE names the upstream project and links its source, so the guard reads both from there
// instead of spelling them out here.
function upstreamFromNotice(notice: string): Upstream {
  const lines = notice.split(/\r?\n/);
  const name = lines
    .map((line) => /^"([^"]+)" is the name of the upstream project\./.exec(line)?.[1])
    .find(Boolean);
  if (!name) throw new Error("NOTICE no longer names the upstream project.");
  const prefix = `This product is derived from ${name} (`;
  const derived = lines.find((line) => line.startsWith(prefix) && line.endsWith("),"));
  const source = derived?.slice(prefix.length, -2) ?? "";
  const owner = /^https:\/\/github\.com\/([^/]+)\/[^/]+$/.exec(source)?.[1];
  if (!owner) throw new Error("NOTICE no longer links the upstream source.");
  return { name, source, owner };
}

function forbiddenTerms(upstream: Upstream): Term[] {
  return [
    // Also covers the upstream domains, e-mail addresses, app ids and environment prefixes.
    { label: "upstream name", value: upstream.name.toLowerCase() },
    // The upstream source and image owner on GitHub and GHCR.
    { label: "upstream source owner", value: upstream.owner.toLowerCase() },
    { label: "upstream maintainer site", value: maintainerSite },
  ];
}

function datedChangelogEntry(upstream: Upstream): string {
  return `- Forked from ${upstream.name} commit \`${fork.commit}\` (${fork.date}) under Apache-2.0. See \`NOTICE\`.`;
}

function findReferences(path: string, body: Buffer, upstream: Upstream): Reference[] {
  if (path === "LICENSE" || path === "NOTICE") return [];
  const terms = forbiddenTerms(upstream);
  const found: Reference[] = terms
    .filter((term) => path.toLowerCase().includes(term.value))
    .map((term) => ({ path, line: null, label: term.label }));
  // latin1 keeps one character per byte, so ASCII terms match in text and binary files alike.
  const text = body.toString("latin1");
  const lowerText = text.toLowerCase();
  const present = terms.filter((term) => lowerText.includes(term.value));
  if (present.length === 0) return found;
  if (body.subarray(0, 8192).includes(0)) {
    return [...found, ...present.map((term) => ({ path, line: null, label: term.label }))];
  }
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    if (path === "CHANGELOG.md" && line === datedChangelogEntry(upstream)) return;
    const lower = line.toLowerCase();
    for (const term of present) {
      if (lower.includes(term.value)) found.push({ path, line: index + 1, label: term.label });
    }
  });
  return found;
}

function describeReference({ path, line, label }: Reference): string {
  return `${path}${line === null ? "" : `:${line}`}: ${label}`;
}

function unexpectedReferences(references: Reference[], allowlist: AllowlistEntry[]): string[] {
  const allowed = new Set<Reference>();
  const stale: string[] = [];
  for (const entry of allowlist) {
    const matches = references.filter(
      (reference) => reference.path === entry.path && reference.label === entry.label,
    );
    if (matches.length === entry.lines) {
      for (const match of matches) allowed.add(match);
    } else {
      stale.push(
        `${entry.path}: allowlist entry for card ${entry.card} expects ${entry.lines} line(s) with the ${entry.label}, found ${matches.length}`,
      );
    }
  }
  return [
    ...references.filter((reference) => !allowed.has(reference)).map(describeReference),
    ...stale,
  ];
}

function requiredAttribution(upstream: Upstream): Record<"NOTICE" | "LICENSE", string[]> {
  return {
    NOTICE: [
      "Copyright 2026 ArdurAI",
      `Copyright 2026 ${upstream.name} contributors`,
      `This product is derived from ${upstream.name} (${upstream.source}),`,
      `Copyright the ${upstream.name} contributors, licensed under the Apache License,`,
      `Version 2.0. Ardur was forked from ${upstream.name} commit ${fork.commit} on ${fork.date}.`,
      "Files were modified for Ardur, including a project-wide rename; see",
      `"${upstream.name}" is the name of the upstream project. Ardur is not affiliated`,
      `with or endorsed by the ${upstream.name} project.`,
    ],
    LICENSE: ["Copyright 2026 Ardur contributors", `Copyright 2026 ${upstream.name} contributors`],
  };
}

function missingAttribution(
  files: Record<"NOTICE" | "LICENSE", string>,
  upstream: Upstream,
): string[] {
  return Object.entries(requiredAttribution(upstream)).flatMap(([file, lines]) => {
    const present = new Set(files[file as "NOTICE" | "LICENSE"].split(/\r?\n/));
    return lines.filter((line) => !present.has(line)).map((line) => `${file} is missing: ${line}`);
  });
}

function git(args: string[]): string[] {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}

// Files whose working-tree contents mention a term, binary files included. Reading only these
// keeps the scan fast; findReferences still checks every path and classifies every line.
function filesMentioning(terms: Term[]): Set<string> {
  try {
    return new Set(git(["grep", "-l", "-z", "-i", "-F", ...terms.flatMap((t) => ["-e", t.value])]));
  } catch (error) {
    if ((error as { status?: number }).status === 1) return new Set(); // No file matched.
    throw error;
  }
}

function trackedReferences(upstream: Upstream): Reference[] {
  const mentioning = filesMentioning(forbiddenTerms(upstream));
  return git(["ls-files", "-z"]).flatMap((path) => {
    const absolute = resolve(root, path);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return []; // Uncommitted deletions are not part of the tree.
    if (stat.isSymbolicLink()) {
      return findReferences(path, Buffer.from(readlinkSync(absolute)), upstream);
    }
    const body = mentioning.has(path) ? readFileSync(absolute) : Buffer.alloc(0);
    return findReferences(path, body, upstream);
  });
}

describe("upstream references", () => {
  it(
    "appear only in LICENSE, NOTICE and the dated CHANGELOG entry",
    () => {
      const upstream = upstreamFromNotice(readText("NOTICE"));
      expect(unexpectedReferences(trackedReferences(upstream), temporaryAllowlist)).toEqual([]);
    },
    sourceScanTimeout,
  );

  it("keeps the upstream attribution and copyright lines in NOTICE and LICENSE", () => {
    const files = { NOTICE: readText("NOTICE"), LICENSE: readText("LICENSE") };
    expect(missingAttribution(files, upstreamFromNotice(files.NOTICE))).toEqual([]);
  });

  it("finds every form of a reference and exempts only the attribution", () => {
    const upstream = upstreamFromNotice(readText("NOTICE"));
    const name = upstream.name;
    const lower = name.toLowerCase();
    const found = (path: string, body: string | Buffer) =>
      findReferences(path, typeof body === "string" ? Buffer.from(body) : body, upstream).map(
        describeReference,
      );

    expect(found("apps/api/src/env.ts", `const key = "${name.toUpperCase()}_TOKEN";`)).toEqual([
      "apps/api/src/env.ts:1: upstream name",
    ]);
    expect(found("docs/guide.md", `See https://www.${lower}.com/docs.`)).toEqual([
      "docs/guide.md:1: upstream name",
    ]);
    expect(found(".github/workflows/release.yml", `image: ghcr.io/${upstream.owner}/app`)).toEqual([
      ".github/workflows/release.yml:1: upstream source owner",
    ]);
    expect(found("apps/web/public/logo.svg", `<svg>\n<title>${name} logo</title></svg>`)).toEqual([
      "apps/web/public/logo.svg:2: upstream name",
    ]);
    expect(found("apps/www/src/new.ts", `href="https://www.${maintainerSite}/"`)).toEqual([
      "apps/www/src/new.ts:1: upstream maintainer site",
    ]);
    expect(
      found("assets/icon.png", Buffer.concat([Buffer.from([0x89, 0x00]), Buffer.from(name)])),
    ).toEqual(["assets/icon.png: upstream name"]);
    expect(found(`docs/${lower}-notes.md`, "")).toEqual([`docs/${lower}-notes.md: upstream name`]);

    const entry = datedChangelogEntry(upstream);
    expect(found("CHANGELOG.md", `# Changelog\n\n${entry}\r\n`)).toEqual([]);
    expect(found("CHANGELOG.md", `${entry}\n- Merged ${name} again.`)).toEqual([
      "CHANGELOG.md:2: upstream name",
    ]);
    expect(found("CHANGELOG.md", entry.replace(fork.date, "2026-10-01"))).toEqual([
      "CHANGELOG.md:1: upstream name",
    ]);
    expect(found("NOTICE", `${name} ${upstream.owner} ${maintainerSite}`)).toEqual([]);
    expect(found("LICENSE", `Copyright 2026 ${name} contributors`)).toEqual([]);
    expect(found("apps/api/src/NOTICE.ts", name)).toEqual([
      "apps/api/src/NOTICE.ts:1: upstream name",
    ]);
  });

  it("fails an allowlist entry that no longer matches, so fixed entries are removed", () => {
    const entry = {
      card: "B16-1",
      path: "apps/www/a.ts",
      label: "upstream maintainer site",
      lines: 1,
    };
    const reference = (line: number) => ({ path: entry.path, line, label: entry.label });

    expect(unexpectedReferences([reference(3)], [entry])).toEqual([]);
    expect(unexpectedReferences([reference(3), reference(9)], [entry])).toEqual([
      "apps/www/a.ts:3: upstream maintainer site",
      "apps/www/a.ts:9: upstream maintainer site",
      "apps/www/a.ts: allowlist entry for card B16-1 expects 1 line(s) with the upstream maintainer site, found 2",
    ]);
    expect(unexpectedReferences([], [entry])).toEqual([
      "apps/www/a.ts: allowlist entry for card B16-1 expects 1 line(s) with the upstream maintainer site, found 0",
    ]);
  });

  it("reports removed attribution", () => {
    const files = { NOTICE: readText("NOTICE"), LICENSE: readText("LICENSE") };
    const upstream = upstreamFromNotice(files.NOTICE);
    const copyright = `Copyright 2026 ${upstream.name} contributors`;

    expect(
      missingAttribution(
        { ...files, LICENSE: files.LICENSE.replace(`${copyright}\n`, "") },
        upstream,
      ),
    ).toEqual([`LICENSE is missing: ${copyright}`]);
    expect(
      missingAttribution(
        { ...files, NOTICE: files.NOTICE.replace("Copyright 2026 ArdurAI\n", "") },
        upstream,
      ),
    ).toEqual(["NOTICE is missing: Copyright 2026 ArdurAI"]);
    expect(() => upstreamFromNotice(files.NOTICE.replace(/^".*$/m, ""))).toThrow(
      "NOTICE no longer names the upstream project.",
    );
    expect(() =>
      upstreamFromNotice(files.NOTICE.replace(/^This product is derived from .*$/m, "")),
    ).toThrow("NOTICE no longer links the upstream source.");
  });
});
