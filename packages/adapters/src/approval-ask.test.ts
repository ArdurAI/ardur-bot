import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
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
