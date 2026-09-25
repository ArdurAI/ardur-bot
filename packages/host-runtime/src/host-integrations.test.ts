import type { HostIntegrationId } from "@ardurbot/contracts/host-integrations";
import { HOST_INTEGRATIONS, hostIntegrationCommand } from "@ardurbot/contracts/host-integrations";
import { describe, expect, it, vi } from "vitest";
import {
  detectHostIntegrations,
  parseHostIdentity,
  verifyHostIntegration,
} from "./host-integrations.js";

const fixtures: [HostIntegrationId, string, string, string | null][] = [
  [
    "github",
    JSON.stringify({
      hosts: {
        "github.example.test": [
          { active: true, state: "success", login: "account-one", token: "fake-never-export" },
        ],
      },
    }),
    "account-one",
    "github.example.test",
  ],
  [
    "gitlab",
    "✓ Logged in to gitlab.example.test as account-two (config file)",
    "account-two",
    "gitlab.example.test",
  ],
  [
    "aws",
    JSON.stringify({
      Arn: "arn:aws:iam::000000000000:role/test-role",
      Account: "000000000000",
      UserId: "ignored",
    }),
    "arn:aws:iam::000000000000:role/test-role",
    "000000000000",
  ],
  [
    "google-cloud",
    JSON.stringify({ core: { account: "account@example.test" } }),
    "account@example.test",
    null,
  ],
  [
    "azure",
    JSON.stringify({
      user: { name: "account@example.test" },
      name: "test-subscription",
      id: "ignored",
    }),
    "account@example.test",
    "test-subscription",
  ],
  ["kubernetes", "test-context\n", "test-context", "test-context"],
  ["jenkins", "Authenticated as: test-user\nAuthorities:\n  authenticated\n", "test-user", null],
];

describe("host sign-in identity boundary", () => {
  it.each(fixtures)("selects only identity fields for %s", (id, output, identity, workspace) => {
    expect(parseHostIdentity(id, output)).toEqual({ identity, workspace });
    expect(JSON.stringify(parseHostIdentity(id, output))).not.toContain("fake-never-export");
  });
  it("does not trust gh JSON exit success when its active account failed authentication", () => {
    expect(
      parseHostIdentity(
        "github",
        JSON.stringify({
          hosts: {
            "github.example.test": [{ active: true, state: "failed", login: "account-one" }],
          },
        }),
      ).identity,
    ).toBeNull();
    expect(parseHostIdentity("jenkins", "Authenticated as: anonymous").identity).toBeNull();
  });
  it("probes fixed commands, exposes missing tools, and never returns raw probe output", async () => {
    const probe = vi.fn(async (binary: string) => ({
      code: 0,
      output: fixtures.find(([id]) => HOST_INTEGRATIONS[id].command === binary)?.[1] ?? "",
    }));
    const result = await detectHostIntegrations({
      getHostEnvironment: async () => ({
        env: { PATH: "/test/bin", JENKINS_URL: "https://jenkins.example.test/" },
      }),
      resolveHostBinary: async (name: string) => (name === "az" ? undefined : name),
      hostProbe: probe,
    });
    expect(result.find((entry) => entry.id === "azure")).toMatchObject({
      state: "not-found",
      identity: null,
    });
    expect(result.find((entry) => entry.id === "jenkins")).toMatchObject({
      state: "signed-in",
      workspace: "jenkins.example.test",
    });
    expect(result.filter((entry) => entry.state === "signed-in")).toHaveLength(6);
    expect(JSON.stringify(result)).not.toContain("fake-never-export");
    expect(probe).toHaveBeenCalledWith(
      "gh",
      ["auth", "status", "--active", "--json", "hosts"],
      expect.any(Object),
      true,
      8000,
      process.platform,
      false,
    );
  });
  it("treats a network or process failure as unavailable, without claiming credentials expired", async () => {
    const result = await detectHostIntegrations({
      getHostEnvironment: async () => ({ env: {} }),
      resolveHostBinary: async (name: string) => name,
      hostProbe: async () => ({ code: 1, output: "fake-sensitive-diagnostic", failure: "timeout" }),
    });
    expect(result.every((entry) => entry.state === "unavailable")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fake-sensitive-diagnostic");
  });
  it.each([
    ["github", ["auth", "token"]],
    ["github", ["extension", "exec", "test"]],
    ["aws", ["sts", "assume-role"]],
    ["aws", ["configure", "export-credentials"]],
    ["kubernetes", ["get", "secrets"]],
    ["kubernetes", ["get", "pods", "--raw=/api"]],
    ["google-cloud", ["auth", "print-access-token"]],
    ["azure", ["account", "get-access-token"]],
    ["jenkins", ["groovy", "="]],
    ["gitlab", ["api", "user"]],
  ])("rejects credential and executable escape commands for %s", (id, args) => {
    expect(() => hostIntegrationCommand(id as string, { args })).toThrow();
  });
  it.each([
    ["github", ["issue", "create", "--title", "test"]],
    ["gitlab", ["mr", "list"]],
    ["aws", ["ec2", "describe-instances"]],
    ["google-cloud", ["compute", "instances", "list"]],
    ["azure", ["group", "list"]],
    ["kubernetes", ["get", "pods"]],
    ["jenkins", ["build", "test-job"]],
  ])("uses a fixed executable for approved %s commands", (id, args) => {
    expect(hostIntegrationCommand(id as string, { args })).toEqual([
      HOST_INTEGRATIONS[id as HostIntegrationId].command,
      ...args,
    ]);
  });
});

it("rechecks account identity before command execution and refuses changed credentials", async () => {
  const deps = {
    getHostEnvironment: async () => ({ env: {} }),
    resolveHostBinary: async () => "gh",
    hostProbe: async () => ({ code: 0, output: fixtures[0]![1] }),
  };
  const expected = {
    id: "github" as const,
    identity: "account-one",
    workspace: "github.example.test",
  };
  await expect(
    verifyHostIntegration(expected, ["gh", "issue", "list"], deps),
  ).resolves.toBeUndefined();
  await expect(
    verifyHostIntegration(
      { ...expected, identity: "different-account" },
      ["gh", "issue", "list"],
      deps,
    ),
  ).rejects.toThrow("account changed");
  await expect(verifyHostIntegration(expected, ["sh", "issue", "list"], deps)).rejects.toThrow(
    "Invalid integration command",
  );
});
