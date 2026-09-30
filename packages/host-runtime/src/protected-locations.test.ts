import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProtectedLocation } from "@ardurbot/contracts/protected-locations";
import { afterEach, describe, expect, it } from "vitest";
import { seatbeltProfile } from "./host-guardrails.js";
import {
  broadProtectedLocations,
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

describe("a location that would deny too much", () => {
  const place = (paths: string[]): ProtectedLocation[] => [
    { id: "place", label: "Place", paths, kind: "credentials" },
  ];

  it.each(["~//", "~///", "~/a/..", "~/a/..//", "~/./"])(
    "never names the home folder itself: %j",
    async (entry) => {
      // The schema refuses these before they are stored. Built by hand, they are refused
      // here too, so the home folder can never reach the deny list.
      const home = await scratchHome();
      expect(() =>
        protectedPaths({ process: "bot-command", grants: [], locations: place([entry]), home }),
      ).toThrow();
    },
  );

  it("names a path with a separator at its end as the folder it means", async () => {
    const home = await realpath(await scratchHome());
    await mkdir(path.join(home, ".keys"));
    expect(
      protectedPaths({
        process: "bot-command",
        grants: [],
        locations: place(["~/.keys/"]),
        home,
      }),
    ).toEqual([path.join(home, ".keys")]);
  });

  it("denies the link and not its target when the target is the home folder, a folder above it or the root", async () => {
    const home = await realpath(await scratchHome());
    for (const [name, target] of [
      ["to-home", home],
      ["to-parent", path.dirname(home)],
      ["to-root", path.parse(home).root],
    ] as const) {
      await symlink(target, path.join(home, name));
      const locations = place([`~/${name}`]);
      const denied = protectedPaths({ process: "bot-command", grants: [], locations, home });
      expect(denied, name).toEqual([path.join(home, name)]);
      expect(broadProtectedLocations({ locations, home }), name).toEqual(["place"]);
    }
  });

  it("denies a link's target anywhere else, such as keys kept on another disk", async () => {
    const home = await realpath(await scratchHome());
    const disk = await realpath(await scratchHome());
    await mkdir(path.join(disk, "keys"));
    await symlink(path.join(disk, "keys"), path.join(home, ".keys"));
    const locations = place(["~/.keys"]);
    expect(protectedPaths({ process: "bot-command", grants: [], locations, home }).sort()).toEqual(
      [path.join(disk, "keys"), path.join(home, ".keys")].sort(),
    );
    expect(broadProtectedLocations({ locations, home })).toEqual([]);
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

  it("stays silent for a command that succeeded, whatever it printed", async () => {
    const home = await scratchHome();
    const output = `cat: ${path.join(home, ".aws", "credentials")}: Operation not permitted`;
    expect(
      protectedLocationHint(output, scratchLocations, home, process.platform, 0),
    ).toBeUndefined();
    expect(protectedLocationHint(output, scratchLocations, home, process.platform, 1)).toContain(
      "Amazon Web Services credentials",
    );
  });

  it("stays silent when the output only mentions a protected path", async () => {
    const home = await scratchHome();
    // A listing, or a command that was granted the location: nothing was refused.
    for (const output of [
      `${path.join(home, ".aws", "credentials")}\n${path.join(home, ".aws", "config")}`,
      `Wrote the profile to ${path.join(home, ".aws", "config")}.`,
      "Reading ~/.ssh/config",
    ])
      expect(protectedLocationHint(output, scratchLocations, home)).toBeUndefined();
  });

  it.each(["Operation not permitted", "Permission denied", "EPERM", "EACCES"])(
    "names the location for a refusal worded %j",
    async (words) => {
      const home = await scratchHome();
      expect(
        protectedLocationHint(
          `open ${path.join(home, ".ssh", "id_ed25519")}: ${words}`,
          scratchLocations,
          home,
        ),
      ).toContain("SSH keys");
    },
  );

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

/**
 * Real `/usr/bin/sandbox-exec` runs of the deny list this module builds, in the
 * style of the host-guardrails tests: a rule shape the kernel ignores cannot stay
 * green. A scratch folder stands in for the home folder, so the owner's real
 * credential and agent-tool folders are never touched. Skipped where there is no
 * sandbox-exec (non-macOS); inside an already-sandboxed process the kernel refuses
 * a second profile and these tests cannot run there.
 */
describe.skipIf(process.platform !== "darwin")(
  "protected locations under real sandbox-exec",
  () => {
    const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

    function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
      return new Promise((resolve) => {
        execFile(argv[0]!, argv.slice(1), { timeout: 15_000 }, (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({ code, stdout, stderr });
        });
      });
    }

    function sandboxed(profile: string, argv: string[]) {
      return run([SANDBOX_EXEC, "-p", profile, ...argv]);
    }

    async function protectedHome(): Promise<string> {
      const home = await mkdtemp(path.join(tmpdir(), "protected-sandbox-"));
      cleanup.push(home);
      // The folders a real home would hold, with fake material only.
      await mkdir(path.join(home, ".aws"));
      await mkdir(path.join(home, ".ssh"));
      await mkdir(path.join(home, ".codex"));
      await mkdir(path.join(home, "project"));
      await writeFile(
        path.join(home, ".aws", "credentials"),
        "[default]\naws_access_key_id = FAKE\n",
      );
      await writeFile(path.join(home, "project", "notes.txt"), "ordinary work\n");
      return home;
    }

    function guardFor(home: string, grants: string[] = []) {
      return seatbeltProfile(
        withProtectedLocations(
          { paths: [], ports: [], sockets: [] },
          protectedPaths({ process: "bot-command", grants, locations: scratchLocations, home }),
        ),
      );
    }

    it("keeps a command from reading or writing a protected location", async () => {
      const home = await protectedHome();
      const profile = guardFor(home);
      const denied = await sandboxed(profile, ["/bin/cat", path.join(home, ".aws", "credentials")]);
      expect(denied.code).not.toBe(0);
      expect(denied.stdout).not.toContain("FAKE");
      const write = await sandboxed(profile, [
        "/bin/sh",
        "-c",
        `echo planted > ${JSON.stringify(path.join(home, ".ssh", "authorized_keys"))}`,
      ]);
      expect(write.code).not.toBe(0);
      // The same profile leaves ordinary work alone.
      const allowed = await sandboxed(profile, [
        "/bin/cat",
        path.join(home, "project", "notes.txt"),
      ]);
      expect(allowed.code).toBe(0);
      expect(allowed.stdout).toBe("ordinary work\n");
    });

    it("lets a granted location read again", async () => {
      const home = await protectedHome();
      const profile = guardFor(home, ["aws"]);
      const granted = await sandboxed(profile, [
        "/bin/cat",
        path.join(home, ".aws", "credentials"),
      ]);
      expect(granted.code).toBe(0);
      expect(granted.stdout).toContain("FAKE");
      // The grant opened exactly its location: SSH stays denied.
      const stillDenied = await sandboxed(profile, [
        "/bin/sh",
        "-c",
        `cat ${JSON.stringify(path.join(home, ".ssh", "authorized_keys"))}`,
      ]);
      expect(stillDenied.code).not.toBe(0);
    });

    it("keeps a command from creating a file inside an agent tool's folder", async () => {
      const home = await protectedHome();
      const profile = guardFor(home);
      const planted = await sandboxed(profile, [
        "/bin/sh",
        "-c",
        `echo planted > ${JSON.stringify(path.join(home, ".codex", "AGENTS.md"))}`,
      ]);
      expect(planted.code).not.toBe(0);
      await expect(access(path.join(home, ".codex", "AGENTS.md"))).rejects.toThrow();
    });

    it("keeps a command from linking into, moving, deleting or replacing an agent tool's folder", async () => {
      // A tool that loads its own folder trusts what is in it. A command that could swap the
      // folder for a prepared copy, even for a moment, would decide what the tool loads.
      const home = await protectedHome();
      const folder = path.join(home, ".codex");
      await writeFile(path.join(folder, "AGENTS.md"), "tool instructions\n");
      const prepared = path.join(home, "project", "prepared");
      await mkdir(prepared);
      await writeFile(path.join(prepared, "AGENTS.md"), "planted\n");
      const profile = guardFor(home);
      for (const argv of [
        ["/bin/ln", "-s", prepared, path.join(folder, "planted")],
        ["/bin/mv", folder, `${folder}.kept`],
        ["/bin/ln", "-sfn", prepared, folder],
      ]) {
        const attempt = await sandboxed(profile, argv);
        expect(attempt.code, argv.join(" ")).not.toBe(0);
      }
      // A forced delete reports success for a folder it cannot even see. What counts is
      // that the folder is still there.
      await sandboxed(profile, ["/bin/rm", "-rf", folder]);
      expect((await lstat(folder)).isDirectory()).toBe(true);
      expect(await readFile(path.join(folder, "AGENTS.md"), "utf8")).toBe("tool instructions\n");
      await expect(access(`${folder}.kept`)).rejects.toThrow();
    });

    it("keeps a command out of a location that did not exist when protection began", async () => {
      // A machine without `~/.aws` today may get one tomorrow. The profile is built from
      // the path as spelled, so the folder is protected from the moment it appears.
      const home = await protectedHome();
      await rm(path.join(home, ".aws"), { recursive: true });
      const profile = guardFor(home);
      await mkdir(path.join(home, ".aws"));
      await writeFile(path.join(home, ".aws", "credentials"), "[default]\nkey = FAKE\n");
      const read = await sandboxed(profile, ["/bin/cat", path.join(home, ".aws", "credentials")]);
      expect(read.code).not.toBe(0);
      expect(read.stdout).not.toContain("FAKE");
      const write = await sandboxed(profile, [
        "/bin/sh",
        "-c",
        `echo planted > ${JSON.stringify(path.join(home, ".aws", "config"))}`,
      ]);
      expect(write.code).not.toBe(0);
    });

    it("keeps a command out of a location that is a single file", async () => {
      const home = await protectedHome();
      await writeFile(path.join(home, ".tool.json"), '{"token":"FAKE"}\n');
      await writeFile(path.join(home, ".tool.json.notes"), "beside it\n");
      const profile = seatbeltProfile(
        withProtectedLocations(
          { paths: [], ports: [], sockets: [] },
          protectedPaths({
            process: "bot-command",
            grants: [],
            locations: [
              { id: "tool", label: "Tool sign-in", paths: ["~/.tool.json"], kind: "credentials" },
            ],
            home,
          }),
        ),
      );
      const read = await sandboxed(profile, ["/bin/cat", path.join(home, ".tool.json")]);
      expect(read.code).not.toBe(0);
      expect(read.stdout).not.toContain("FAKE");
      // A file whose name only starts the same way is not part of the location.
      const beside = await sandboxed(profile, ["/bin/cat", path.join(home, ".tool.json.notes")]);
      expect(beside.code).toBe(0);
    });

    it("lets an agent runtime read its own tool folder", async () => {
      const home = await protectedHome();
      await writeFile(path.join(home, ".codex", "AGENTS.md"), "tool instructions\n");
      const profile = seatbeltProfile(
        withProtectedLocations(
          { paths: [], ports: [], sockets: [] },
          protectedPaths({
            process: "agent-runtime",
            tool: "codex-app-server",
            grants: [],
            locations: scratchLocations,
            home,
          }),
        ),
      );
      const own = await sandboxed(profile, ["/bin/cat", path.join(home, ".codex", "AGENTS.md")]);
      expect(own.code).toBe(0);
      expect(own.stdout).toBe("tool instructions\n");
      // Its own folder is open; every other location stays denied.
      const other = await sandboxed(profile, ["/bin/cat", path.join(home, ".aws", "credentials")]);
      expect(other.code).not.toBe(0);
    });
  },
);
