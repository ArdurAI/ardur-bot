import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProtectedLocation } from "@ardurbot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  protectedLocationHint,
  protectedLocationOf,
  protectedPaths,
  withProtectedLocations,
} from "./protected-locations.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratchHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "protected-locations-"));
  cleanup.push(home);
  return home;
}

/** A small table with the same shape as the defaults, over a scratch home. */
const scratchLocations: ProtectedLocation[] = [
  { id: "aws", label: "Amazon Web Services credentials", paths: ["~/.aws"], kind: "credentials" },
  { id: "ssh", label: "SSH keys", paths: ["~/.ssh"], kind: "credentials" },
  {
    id: "codex",
    label: "Codex configuration",
    paths: ["~/.codex"],
    kind: "agent-tool",
    tool: "codex-app-server",
  },
  {
    id: "claude-code",
    label: "Claude Code configuration",
    paths: ["~/.claude", "~/.claude.json"],
    kind: "agent-tool",
    tool: "claude-code",
  },
];

const allIds = scratchLocations.map((location) => location.id);

/** The location ids whose absolute folder a paths list covers. */
function idsCoveredBy(home: string, paths: string[]): Set<string> {
  const covered = new Set<string>();
  for (const location of scratchLocations)
    for (const entry of location.paths) {
      const absolute = path.join(home, entry.slice(2));
      if (paths.some((denied) => denied === absolute || denied.startsWith(absolute + path.sep)))
        covered.add(location.id);
    }
  return covered;
}

describe("protectedPaths", () => {
  it("keeps a bot command out of every location, inside the home", async () => {
    const home = await scratchHome();
    const realHome = await realpath(home);
    const paths = protectedPaths({
      process: "bot-command",
      grants: [],
      locations: scratchLocations,
      home,
    });
    expect(idsCoveredBy(home, paths)).toEqual(new Set(allIds));
    // Each denied path stays inside the home, in the spelling the disk uses for it.
    for (const denied of paths)
      expect(denied.startsWith(home) || denied.startsWith(realHome)).toBe(true);
  });

  it("keeps each process kind out of the locations its rule names", async () => {
    const home = await scratchHome();
    await mkdir(path.join(home, ".ssh"));
    await mkdir(path.join(home, ".codex"));

    const bot = protectedPaths({
      process: "bot-command",
      grants: [],
      locations: scratchLocations,
      home,
    });
    expect(idsCoveredBy(home, bot)).toEqual(new Set(allIds));

    const runtime = protectedPaths({
      process: "agent-runtime",
      tool: "codex-app-server",
      grants: [],
      locations: scratchLocations,
      home,
    });
    expect(idsCoveredBy(home, runtime)).toEqual(new Set(allIds.filter((id) => id !== "codex")));

    const probe = protectedPaths({
      process: "tool-probe",
      tool: "claude-code",
      grants: [],
      locations: scratchLocations,
      home,
    });
    expect(idsCoveredBy(home, probe)).toEqual(new Set(allIds.filter((id) => id !== "claude-code")));

    for (const process of ["owner-mcp-server", "board-runner"] as const)
      expect(protectedPaths({ process, grants: [], locations: scratchLocations, home })).toEqual(
        [],
      );
  });

  it("a grant removes exactly its location", async () => {
    const home = await scratchHome();
    const granted = protectedPaths({
      process: "bot-command",
      grants: ["ssh"],
      locations: scratchLocations,
      home,
    });
    expect(idsCoveredBy(home, granted)).toEqual(new Set(allIds.filter((id) => id !== "ssh")));
  });

  it("an agent runtime keeps its own folder", async () => {
    const home = await scratchHome();
    await mkdir(path.join(home, ".codex"));
    const paths = protectedPaths({
      process: "agent-runtime",
      tool: "codex-app-server",
      grants: [],
      locations: scratchLocations,
      home,
    });
    const codexFolder = path.join(home, ".codex");
    expect(
      paths.some((denied) => denied === codexFolder || denied.startsWith(codexFolder + path.sep)),
    ).toBe(false);
    expect(idsCoveredBy(home, paths)).toEqual(new Set(allIds.filter((id) => id !== "codex")));
  });

  it("a location given through a link resolves to its target", async () => {
    const home = await scratchHome();
    const real = path.join(home, "actual-home", ".ssh");
    await mkdir(real, { recursive: true });
    const linkedHome = path.join(home, "linked-home");
    await symlink(path.join(home, "actual-home"), linkedHome);
    const paths = protectedPaths({
      process: "bot-command",
      grants: [],
      locations: scratchLocations,
      home: linkedHome,
    });
    expect(paths).toContain(await realpath(real));
    expect(paths).toContain(path.join(linkedHome, ".ssh"));
  });

  it("two bots with different grants get different paths", async () => {
    const home = await scratchHome();
    const first = protectedPaths({
      process: "bot-command",
      grants: ["ssh"],
      locations: scratchLocations,
      home,
    });
    const second = protectedPaths({
      process: "bot-command",
      grants: ["aws"],
      locations: scratchLocations,
      home,
    });
    expect(first).not.toEqual(second);
    expect(idsCoveredBy(home, first).has("aws")).toBe(true);
    expect(idsCoveredBy(home, second).has("ssh")).toBe(true);
  });

  it("refuses a location path that leaves the home after resolving ..", async () => {
    const home = await scratchHome();
    const outside: ProtectedLocation[] = [
      { id: "escape", label: "Escape", paths: ["~/../../elsewhere"], kind: "credentials" },
    ];
    expect(() =>
      protectedPaths({ process: "bot-command", grants: [], locations: outside, home }),
    ).toThrow(/leaves the home folder/);
  });
});

describe("withProtectedLocations", () => {
  it("adds the paths without changing the guard it was given", () => {
    const guard = { paths: ["/srv/stack/.env"], ports: [5432], sockets: ["/var/run/docker.sock"] };
    const before = JSON.parse(JSON.stringify(guard));
    const withPaths = withProtectedLocations(guard, ["/home/u/.ssh", "/srv/stack/.env"]);
    expect(withPaths).toEqual({
      paths: ["/srv/stack/.env", "/home/u/.ssh"],
      ports: [5432],
      sockets: ["/var/run/docker.sock"],
    });
    expect(guard).toEqual(before);
  });
});

describe("protectedLocationOf", () => {
  it("finds the location a path belongs to", async () => {
    const home = await scratchHome();
    await mkdir(path.join(home, ".ssh"));
    await writeFile(path.join(home, ".claude.json"), "{}");
    expect(
      protectedLocationOf(path.join(home, ".ssh", "id_ed25519"), scratchLocations, home)?.id,
    ).toBe("ssh");
    expect(protectedLocationOf(path.join(home, ".claude.json"), scratchLocations, home)?.id).toBe(
      "claude-code",
    );
    expect(
      protectedLocationOf(path.join(home, "notes.txt"), scratchLocations, home),
    ).toBeUndefined();
  });

  it("follows a link to the location's target", async () => {
    const home = await scratchHome();
    const target = path.join(home, "keys");
    await mkdir(target);
    const linked = path.join(home, "ssh-link");
    await symlink(target, linked);
    const locations: ProtectedLocation[] = [
      { id: "keys", label: "Keys", paths: ["~/keys"], kind: "credentials" },
    ];
    expect(protectedLocationOf(linked, locations, home)?.id).toBe("keys");
  });
});

describe("protectedLocationHint", () => {
  it("names the location when the output names a path inside it", async () => {
    const home = await scratchHome();
    const output = `cat: ${path.join(home, ".aws", "credentials")}: Operation not permitted`;
    expect(protectedLocationHint(output, scratchLocations, home)).toBe(
      "Amazon Web Services credentials is protected on this computer. The owner can grant this bot access in the bot's settings.",
    );
  });

  it("stays silent for a path outside every location, whatever the words", async () => {
    const home = await scratchHome();
    const denied = `cat: ${path.join(home, "project", "notes.txt")}: Operation not permitted`;
    expect(protectedLocationHint(denied, scratchLocations, home)).toBeUndefined();
    expect(
      protectedLocationHint("Operation not permitted", scratchLocations, home),
    ).toBeUndefined();
    // The words alone, without a path inside a location, decide nothing. A tilde
    // path inside a location does decide: the hint comes from the path.
    expect(
      protectedLocationHint("Permission denied while reading ~/notes.txt", scratchLocations, home),
    ).toBeUndefined();
    expect(
      protectedLocationHint(
        "Permission denied while reading ~/.ssh/id_rsa",
        scratchLocations,
        home,
      ),
    ).toContain("SSH keys");
  });
});
