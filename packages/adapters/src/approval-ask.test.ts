import type { HostCommandApproval } from "@ardurbot/contracts";
import { HOST_INTEGRATIONS, hostIntegrationCommand } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";

function commandAsk(argv: string[], secrets: string[] = []) {
  const hostCommand: HostCommandApproval = {
    id: "github",
    argv,
    identity: "fixture-account",
    workspace: "fixture-workspace",
    cwd: "/workspace",
    computerId: "computer",
  };
  return buildApprovalAskBlock(
    "effect",
    "mcp__fixture__execute_command",
    { args: argv.slice(1) },
    secrets,
    {
      integration: {
        vendorName: "Fixture",
        toolId: "execute_command",
        description: "Execute a command.",
        hostCommand,
      },
    },
  );
}

describe("buildApprovalAskBlock", () => {
  it.each([
    ["github", ["issue", "list"]],
    ["gitlab", ["mr", "list"]],
    ["aws", ["s3", "rm", "s3://example-bucket", "--recursive"]],
    ["google-cloud", ["compute", "instances", "list"]],
    ["azure", ["group", "list"]],
    ["kubernetes", ["delete", "deployment", "example"]],
    ["jenkins", ["build", "example"]],
  ] as const)(
    "shows the fixed %s program and every argument without an always-allow action",
    (id, args) => {
      const argv = hostIntegrationCommand(id, { args });
      const block = commandAsk(argv);
      expect(block).toMatchObject({
        text: [HOST_INTEGRATIONS[id].command, ...args].map((value) => `'${value}'`).join(" "),
        preformatted: true,
        detail:
          "Identity: fixture-account\nWorkspace: fixture-workspace\nWorking directory: '/workspace'",
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      });
    },
  );
  it("quotes whitespace, empty arguments, quotes, Markdown, and shell metacharacters verbatim", () => {
    const block = commandAsk([
      "gh",
      "issue",
      "create",
      "--title",
      "it's $(false); `false` \\ **[label]**",
      "",
    ]);
    expect(block).toMatchObject({
      text: "'gh' 'issue' 'create' '--title' 'it'\"'\"'s $(false); `false` \\ **[label]**' ''",
    });
  });
  it("retains maximum-length argv through the final argument", () => {
    const argv = [
      "gh",
      "issue",
      ...Array.from({ length: 47 }, (_, index) => `${index}-`.padEnd(4096, "x")),
    ];
    const block = commandAsk(argv);
    expect(block.text).toBe(argv.map((arg) => `'${arg}'`).join(" "));
    expect(block.text).not.toContain("…");
  });
  it("redacts known secrets before quoting and masks secret-looking arguments only in the display", () => {
    const argv = [
      "gh",
      "issue",
      "create",
      "--title",
      "known'private",
      "--token",
      "fixture-value",
      "--api-key=fixture-key",
      "ghp_fixturevalue123",
      "Bearer fixture-bearer",
      '{"password":"fixture password"}',
    ];
    const original = [...argv];
    const block = commandAsk(argv, ["known'private"]);
    const display = JSON.stringify(block);
    for (const hidden of [
      "known",
      "fixture-value",
      "fixture-key",
      "ghp_fixturevalue123",
      "fixture-bearer",
      "fixture password",
    ])
      expect(display).not.toContain(hidden);
    expect(block.text).toContain("'[redacted]'");
    expect(block.text).toContain("'--api-key=[redacted]'");
    expect(argv).toEqual(original);
  });
  it.each(["synthetic_write", "graphql_mutation", "cloud_agent_reply"])(
    "retains primitive and nested array payloads for %s",
    (toolName) => {
      const args = {
        ids: ["first", "last"],
        nested: {
          edits: [{ values: [false, 0, "x".repeat(5000), "tail"], password: "fixture-hidden" }],
        },
      };
      const block = buildApprovalAskBlock(
        "effect",
        toolName,
        args,
        [],
        toolName === "synthetic_write"
          ? {
              integration: {
                vendorName: "Fixture",
                toolId: toolName,
                description: "Write content.",
              },
            }
          : undefined,
      );
      if (block.kind !== "ask") throw new Error("Expected an approval");
      expect(block.preformatted).toBe(true);
      expect(block.detail).toContain('"first"');
      expect(block.detail).toContain('"last"');
      expect(block.detail).toContain("x".repeat(5000));
      expect(block.detail).toContain('"tail"');
      expect(block.detail).toContain("false");
      expect(block.detail).toContain("[redacted]");
      expect(block.detail).not.toContain("fixture-hidden");
    },
  );
  it("never falls back to prose when a host command snapshot is missing", () => {
    expect(() =>
      buildApprovalAskBlock(
        "effect",
        "mcp__fixture__execute_command",
        { args: ["issue", "list"] },
        [],
        {
          integration: {
            vendorName: "Fixture",
            toolId: "execute_command",
            description: "Execute a command.",
            hostCommandRequired: true,
          },
        },
      ),
    ).toThrow("command preview is unavailable");
  });
  it("names a vendor and manifest action with a repository target, keeping raw ids in detail", () => {
    const block = buildApprovalAskBlock(
      "effect",
      "mcp__synthetic__synthetic_write",
      {
        owner: "ardurai",
        repo: "ardur-bot",
        issue_number: 12,
      },
      [],
      {
        integration: {
          vendorName: "GitHub",
          toolId: "synthetic_write",
          description: "Create a pull request comment. Extra instructions are not a title.",
        },
        allowAlways: false,
      },
    );
    expect(block).toMatchObject({
      text: "Save this to GitHub?",
      detail:
        "synthetic_write · mcp__synthetic__synthetic_write\nGitHub\nCreate a pull request comment.\nDestination: ardurai/ardur-bot#12",
      actions: [
        { id: "allow", label: "Save" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });
  });
  it("redacts and bounds integration descriptions and targets without rendering manifest Markdown", () => {
    const block = buildApprovalAskBlock(
      "effect",
      "synthetic_write",
      { repository: "secret-repo" },
      ["secret-repo", "secret-description"],
      {
        integration: {
          vendorName: "Synthetic",
          toolId: "synthetic_write",
          description: `**Create** <b>a</b> [comment] secret-description ${"x".repeat(1000)}`,
        },
      },
    );
    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask");
    expect(block.text).toBe("Save this to Synthetic?");
    expect(block.detail).toContain("Create a comment");
    expect(block.text.length).toBeLessThanOrEqual(501);
    expect(JSON.stringify(block)).not.toContain("secret-description");
    expect(JSON.stringify(block)).not.toContain("secret-repo");
    expect(block.detail).toContain("synthetic_write");
  });
  it("handles empty descriptions and non-repository targets without inventing a vendor action", () => {
    expect(
      buildApprovalAskBlock("effect", "synthetic_write", { title: "An item" }, [], {
        integration: { vendorName: "Synthetic", toolId: "synthetic_write", description: "" },
      }),
    ).toMatchObject({
      text: "Save this to Synthetic?",
      detail: "synthetic_write\nSynthetic\nWrite content\nAn item",
    });
  });
  it("binds the approval to its effect and redacts secrets", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", body: "token-secret" },
      ["token-secret"],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("token-secret");
  });

  it("bounds model-controlled summaries and details", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "destination.write",
      { title: "t".repeat(1_000), body: "b".repeat(10_000) },
      [],
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.text.length).toBeLessThanOrEqual(501);
    expect(block.detail?.length).toBeLessThanOrEqual(4_001);
  });

  it("includes an optional review reason as the first detail line", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", subject: "Hi" },
      [],
      { reviewReason: "Sends email outside the draft-only task." },
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.startsWith("Sends email outside the draft-only task.")).toBe(true);
    expect(block.detail).toContain("to: person@example.test");
  });

  it("uses a one-time create or cancel choice for a new security boundary", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "create_space",
      { name: "Customer support" },
      [],
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Create space “Customer support”?",
      actions: [
        { id: "allow", label: "Create space", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("stay separate from other spaces");
  });
});

it("omits permanent allow for a mandatory catalog approval", () => {
  const block = buildApprovalAskBlock("effect", "synthetic_write", {}, [], { allowAlways: false });
  expect(block).toMatchObject({ actions: [{ id: "allow" }, { id: "deny" }] });
});

it("previews nested Notion content and its destination without credential values", () => {
  const block = buildApprovalAskBlock(
    "effect",
    "mcp__demo__synthetic_write",
    {
      parent: { page_id: "a".repeat(32) },
      title: "Weekly notes",
      content: "First line\nSecond line\n" + "x".repeat(5000),
      api_key: "synthetic-sensitive-value",
      body: "synthetic-sensitive-value",
    },
    [],
    {
      integration: {
        vendorName: "Notion",
        toolId: "synthetic_write",
        description: "Create a page.",
      },
    },
  );
  expect(block).toMatchObject({
    text: "Save this to Notion?",
    actions: [
      { id: "allow", label: "Save" },
      { id: "deny", label: "Cancel" },
    ],
  });
  if (block.kind !== "ask") throw new Error("expected ask");
  expect(block.detail).toContain("Weekly notes");
  expect(block.detail).toContain("First line\nSecond line");
  expect(block.detail).toContain("a".repeat(32));
  expect(block.detail!.length).toBeLessThanOrEqual(4001);
  expect(JSON.stringify(block)).not.toContain("synthetic-sensitive-value");
});
it("redacts a secret before truncating content and uses channel-specific Post copy", () => {
  const secret = "z".repeat(2000);
  const block = buildApprovalAskBlock(
    "effect",
    "synthetic_post",
    { channel: "#releases", text: secret },
    [secret],
    {
      integration: {
        vendorName: "Example",
        toolId: "synthetic_post",
        description: "Post a message.",
      },
    },
  );
  expect(block).toMatchObject({
    text: "Post to #releases?",
    actions: [
      { id: "allow", label: "Post" },
      { id: "deny", label: "Cancel" },
    ],
  });
  expect(JSON.stringify(block)).not.toContain("zzz");
});
