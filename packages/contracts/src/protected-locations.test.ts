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
      "codex",
      "claude-code",
      "hermes",
    ])
      expect(allDefaultIds).toContain(id);
    // Every entry Ardur names a tool for is one Ardur can run as a runtime.
    expect(
      PROTECTED_LOCATIONS_DEFAULTS.filter((l) => l.kind === "agent-tool").map((l) => l.tool),
    ).toEqual(["codex-app-server", "claude-code", "hermes"]);
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
      { version: 2, custom: [] },
      { version: 1 },
      { version: 1, custom: "none" },
      { version: 1, custom: [null] },
      { version: 1, custom: [{ id: "aws", label: "AWS", paths: ["~/.aws"], kind: "credentials" }] },
      { version: 1, custom: [{ id: "x", label: "X", paths: ["/etc"], kind: "credentials" }] },
      {
        version: 1,
        custom: [
          { id: "x", label: "X", paths: ["~/.x"], kind: "credentials" },
          { id: "x", label: "X", paths: ["~/.x2"], kind: "credentials" },
        ],
      },
    ])
      expect(parseProtectedLocationsPolicy(bad)).toEqual(empty);
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
