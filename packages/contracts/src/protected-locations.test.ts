import { describe, expect, it } from "vitest";
import type { ProtectedLocation } from "./protected-locations.js";
import {
  deniedLocationIds,
  PROCESS_LOCATION_RULES,
  PROTECTED_LOCATIONS_DEFAULTS,
  ProtectedLocationSchema,
  ProtectedLocationsPolicyV1Schema,
  parseProtectedLocationsPolicy,
  protectedLocations,
  unreadProtectedLocations,
} from "./protected-locations.js";

const vpnLocation: ProtectedLocation = {
  id: "company-vpn",
  label: "Company VPN",
  paths: ["~/.vpn"],
  kind: "credentials",
};

const allDefaultIds = PROTECTED_LOCATIONS_DEFAULTS.map((location) => location.id);

describe("protected location schema", () => {
  it("accepts a credentials location and an agent-tool location", () => {
    expect(
      ProtectedLocationSchema.safeParse({
        id: "aws",
        label: "Amazon Web Services credentials",
        paths: ["~/.aws"],
        kind: "credentials",
      }).success,
    ).toBe(true);
    expect(
      ProtectedLocationSchema.safeParse({
        id: "codex",
        label: "Codex configuration",
        paths: ["~/.codex"],
        kind: "agent-tool",
        tool: "codex-app-server",
      }).success,
    ).toBe(true);
  });

  it("refuses a path that names the home folder itself or a place outside it", () => {
    // An empty part or a separator at the end would read as the home folder; `.` and `..`
    // would let a path walk out of it.
    for (const paths of [
      ["~//"],
      ["~///"],
      ["~/.ssh/"],
      ["~/a//b"],
      ["~/a/.."],
      ["~/a/../.."],
      ["~/../x"],
      ["~/./a"],
      ["~/."],
      ["~/.."],
      // A path is plain text.
      ["~/.keys\nmore"],
      ["~/.keys\u0000"],
      ["~/.keys\u0001"],
      ["~/.ke\tys"],
      ["~/.keys\u007f"],
    ]) {
      expect(
        ProtectedLocationSchema.safeParse({
          id: "custom",
          label: "Custom",
          paths,
          kind: "credentials",
        }).success,
        paths[0],
      ).toBe(false);
    }
    for (const paths of [["~/.ssh"], ["~/.config/gcloud"], ["~/.claude.json"], ["~/a.b/c..d"]]) {
      expect(
        ProtectedLocationSchema.safeParse({
          id: "custom",
          label: "Custom",
          paths,
          kind: "credentials",
        }).success,
        paths[0],
      ).toBe(true);
    }
  });

  it("refuses a path not written from the home folder", () => {
    for (const paths of [["/etc/passwd"], ["~"], ["~/"], ["relative/.ssh"], [""]]) {
      expect(
        ProtectedLocationSchema.safeParse({
          id: "custom",
          label: "Custom",
          paths,
          kind: "credentials",
        }).success,
      ).toBe(false);
    }
  });

  it("refuses a misplaced tool, an unknown kind and an unknown field", () => {
    // An agent-tool location names its tool.
    expect(
      ProtectedLocationSchema.safeParse({
        id: "custom",
        label: "Custom",
        paths: ["~/.tool"],
        kind: "agent-tool",
      }).success,
    ).toBe(false);
    // A credentials location names no tool.
    expect(
      ProtectedLocationSchema.safeParse({
        id: "custom",
        label: "Custom",
        paths: ["~/.secrets"],
        kind: "credentials",
        tool: "codex-app-server",
      }).success,
    ).toBe(false);
    expect(
      ProtectedLocationSchema.safeParse({
        id: "custom",
        label: "Custom",
        paths: ["~/.secrets"],
        kind: "other",
      }).success,
    ).toBe(false);
    expect(
      ProtectedLocationSchema.safeParse({
        id: "custom",
        label: "Custom",
        paths: ["~/.secrets"],
        kind: "credentials",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      ProtectedLocationSchema.safeParse({
        id: "",
        label: "Custom",
        paths: ["~/.s"],
        kind: "credentials",
      }).success,
    ).toBe(false);
  });
});

describe("default protected locations", () => {
  it("gives every entry an id, a label and at least one home-relative path, all unique", () => {
    expect(PROTECTED_LOCATIONS_DEFAULTS.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const location of PROTECTED_LOCATIONS_DEFAULTS) {
      expect(location.id).toBeTruthy();
      expect(location.label).toBeTruthy();
      expect(location.paths.length).toBeGreaterThan(0);
      for (const entry of location.paths) expect(entry.startsWith("~/")).toBe(true);
      expect(ids.has(location.id)).toBe(false);
      ids.add(location.id);
    }
  });

  it("parses under its own schema and carries a tool exactly for agent tools", () => {
    for (const location of PROTECTED_LOCATIONS_DEFAULTS)
      expect(ProtectedLocationSchema.safeParse(location).success).toBe(true);
    for (const location of PROTECTED_LOCATIONS_DEFAULTS)
      expect(location.tool !== undefined).toBe(location.kind === "agent-tool");
  });

  it("covers the owner's cloud credentials and the agent tools", () => {
    for (const id of [
      "aws",
      "azure",
      "google-cloud",
      "kubernetes",
      "ssh",
      "gnupg",
      "github-cli",
      "docker",
      "netrc",
      "npmrc",
      "git-credentials",
      "terraform",
      "pypi",
      "cargo",
      "maven",
      "gradle",
      "codex",
      "claude-code",
      "hermes",
      "gemini",
    ])
      expect(allDefaultIds).toContain(id);
    // Every entry Ardur names a tool for is one Ardur can run as a runtime.
    expect(
      PROTECTED_LOCATIONS_DEFAULTS.filter((l) => l.kind === "agent-tool").map((l) => l.tool),
    ).toEqual(["codex-app-server", "claude-code", "hermes", "antigravity"]);
  });

  it("gives no place to two locations, so a grant always opens what it names", () => {
    const paths = PROTECTED_LOCATIONS_DEFAULTS.flatMap((location) => location.paths);
    for (const path of paths)
      for (const other of paths)
        if (path !== other) {
          expect(path.startsWith(`${other}/`), `${path} inside ${other}`).toBe(false);
        }
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("protected locations policy", () => {
  it("reads no custom locations from unknown or invalid input", () => {
    const empty = { version: 1, custom: [] };
    for (const bad of [
      undefined,
      null,
      "not json",
      7,
      [],
      {},
      { version: 2, custom: [vpnLocation] },
      { version: 1 },
      { version: 1, custom: "none" },
      { version: 1, custom: [null] },
      { version: 1, custom: [{ id: "aws", label: "AWS", paths: ["~/.aws"], kind: "credentials" }] },
      { version: 1, custom: [{ id: "x", label: "X", paths: ["/etc"], kind: "credentials" }] },
    ])
      expect(parseProtectedLocationsPolicy(bad)).toEqual(empty);
  });

  it("keeps every custom location it can read when one entry is bad", () => {
    const second = { id: "lab", label: "Lab keys", paths: ["~/.lab"], kind: "credentials" };
    const stored = {
      version: 1,
      custom: [
        vpnLocation,
        { id: "broken", label: "Broken", paths: ["~//"], kind: "credentials" },
        null,
        // The same id again, and a place that is already protected: left out.
        { ...second, id: "company-vpn" },
        { id: "my-aws", label: "My AWS", paths: ["~/.aws"], kind: "credentials" },
        { id: "inside", label: "Inside SSH", paths: ["~/.ssh/work"], kind: "credentials" },
        { id: "around", label: "Around gcloud", paths: ["~/.config"], kind: "credentials" },
        second,
      ],
    };
    expect(parseProtectedLocationsPolicy(stored)).toEqual({
      version: 1,
      custom: [vpnLocation, second],
    });
    expect(unreadProtectedLocations(stored)).toBe(6);
    expect(unreadProtectedLocations({ version: 1, custom: [vpnLocation] })).toBe(0);
    expect(unreadProtectedLocations("not json")).toBe(0);
  });

  it("reads at most the number of custom locations an owner can add", () => {
    const many = Array.from({ length: 70 }, (_, index) => ({
      id: `place-${index}`,
      label: `Place ${index}`,
      paths: [`~/.place-${index}`],
      kind: "credentials",
    }));
    const read = parseProtectedLocationsPolicy({ version: 1, custom: many });
    expect(read.custom).toHaveLength(64);
    expect(read.custom[0]?.id).toBe("place-0");
    expect(unreadProtectedLocations({ version: 1, custom: many })).toBe(6);
  });

  it("refuses a custom location over a place that is already protected, at the schema", () => {
    for (const paths of [
      ["~/.aws"],
      ["~/.ssh/work"],
      ["~/.config"],
      // On a Mac these name the same folders as `~/.aws` and `~/.ssh`.
      ["~/.AWS"],
      ["~/.Ssh/work"],
      ["~/.CONFIG"],
    ])
      expect(
        ProtectedLocationsPolicyV1Schema.safeParse({
          version: 1,
          custom: [{ id: "mine", label: "Mine", paths, kind: "credentials" }],
        }).success,
        paths[0],
      ).toBe(false);
    // Beside a protected place, not over it.
    expect(
      ProtectedLocationsPolicyV1Schema.safeParse({
        version: 1,
        custom: [{ id: "mine", label: "Mine", paths: ["~/.config/mine"], kind: "credentials" }],
      }).success,
    ).toBe(true);
  });

  it("treats two spellings of one folder as the same place", () => {
    // The same accented name, written as one character and as a letter plus a mark.
    const composed = "~/caf\u00e9";
    const decomposed = "~/cafe\u0301";
    expect(
      ProtectedLocationsPolicyV1Schema.safeParse({
        version: 1,
        custom: [
          { id: "first", label: "First", paths: [composed], kind: "credentials" },
          { id: "second", label: "Second", paths: [decomposed], kind: "credentials" },
        ],
      }).success,
    ).toBe(false);
    expect(
      ProtectedLocationsPolicyV1Schema.safeParse({
        version: 1,
        custom: [
          { id: "first", label: "First", paths: ["~/Keys"], kind: "credentials" },
          { id: "second", label: "Second", paths: ["~/keys/work"], kind: "credentials" },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses a custom id that repeats a default id, at the schema", () => {
    expect(
      ProtectedLocationsPolicyV1Schema.safeParse({
        version: 1,
        custom: [{ id: "ssh", label: "Second SSH", paths: ["~/.ssh2"], kind: "credentials" }],
      }).success,
    ).toBe(false);
  });

  it("accepts a valid custom location", () => {
    expect(parseProtectedLocationsPolicy({ version: 1, custom: [vpnLocation] })).toEqual({
      version: 1,
      custom: [vpnLocation],
    });
  });

  it("lists the defaults followed by the custom ones, with unique ids", () => {
    const locations = protectedLocations({ version: 1, custom: [vpnLocation] });
    expect(locations.length).toBe(PROTECTED_LOCATIONS_DEFAULTS.length + 1);
    expect(locations.slice(0, PROTECTED_LOCATIONS_DEFAULTS.length)).toEqual(
      PROTECTED_LOCATIONS_DEFAULTS,
    );
    expect(locations.at(-1)).toEqual(vpnLocation);
    expect(new Set(locations.map((l) => l.id)).size).toBe(locations.length);
  });

  it("reads the default list when the policy is empty", () => {
    expect(protectedLocations({ version: 1, custom: [] })).toEqual(PROTECTED_LOCATIONS_DEFAULTS);
  });
});

describe("process location rules", () => {
  it("names every process kind the host runs", () => {
    expect(Object.keys(PROCESS_LOCATION_RULES).sort()).toEqual(
      ["agent-runtime", "board-runner", "bot-command", "owner-mcp-server", "tool-probe"].sort(),
    );
  });

  it("keeps a bot command out of every location except one granted to the bot", () => {
    expect(deniedLocationIds({ process: "bot-command", grants: [] })).toEqual(allDefaultIds);
    const withGrant = deniedLocationIds({ process: "bot-command", grants: ["ssh"] });
    expect(withGrant).not.toContain("ssh");
    expect(withGrant.length).toBe(allDefaultIds.length - 1);
    // A grant for an id the table does not know changes nothing.
    expect(deniedLocationIds({ process: "bot-command", grants: ["no-such-location"] })).toEqual(
      allDefaultIds,
    );
  });

  it("keeps an agent runtime out of everything except its own entry and grants", () => {
    // Its own entry is open; every other location is denied, with no grants.
    const codex = deniedLocationIds({
      process: "agent-runtime",
      tool: "codex-app-server",
      grants: [],
    });
    expect(codex).not.toContain("codex");
    expect(codex.length).toBe(allDefaultIds.length - 1);
    // A different tool's entry stays denied.
    expect(codex).toContain("claude-code");
    // A grant removes exactly its location; the own entry stays open either way.
    const granted = deniedLocationIds({
      process: "agent-runtime",
      tool: "codex-app-server",
      grants: ["ssh"],
    });
    expect(granted).not.toContain("ssh");
    expect(granted).not.toContain("codex");
    expect(granted.length).toBe(allDefaultIds.length - 2);
    // Without a tool, every location is denied.
    expect(deniedLocationIds({ process: "agent-runtime", grants: [] })).toEqual(allDefaultIds);
  });

  it("keeps a tool probe out of everything except its own entry, ignoring grants", () => {
    const probe = deniedLocationIds({
      process: "tool-probe",
      tool: "claude-code",
      grants: ["ssh"],
    });
    expect(probe).not.toContain("claude-code");
    expect(probe).toContain("ssh");
    expect(probe).toContain("codex");
    expect(probe.length).toBe(allDefaultIds.length - 1);
    expect(deniedLocationIds({ process: "tool-probe", grants: [] })).toEqual(allDefaultIds);
  });

  it("adds nothing for an owner MCP server or a board runner", () => {
    expect(deniedLocationIds({ process: "owner-mcp-server", grants: [] })).toEqual([]);
    expect(deniedLocationIds({ process: "board-runner", grants: [] })).toEqual([]);
  });

  it("follows custom locations too", () => {
    const locations = protectedLocations({ version: 1, custom: [vpnLocation] });
    const ids = locations.map((l) => l.id);
    expect(deniedLocationIds({ process: "bot-command", grants: [], locations })).toEqual(ids);
    expect(
      deniedLocationIds({ process: "bot-command", grants: ["company-vpn"], locations }),
    ).not.toContain("company-vpn");
  });
});
