import type { IntegrationDescriptor } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { planActionGate, resolveActionApprovalDetail } from "./action-approval.js";
import { approvalFor, effectiveTools, integrationToolKind } from "./integration-policy.js";

const descriptor: IntegrationDescriptor = {
  id: "synthetic",
  name: "Synthetic test integration",
  vendor: "synthetic",
  available: true,
  transport: "remote-http",
  endpoint: "https://example.test/mcp",
  authKind: "oauth",
  requiredInputs: [],
  docsUrl: "https://example.test/docs",
  verifiedAt: "2026-09-23",
  serverVersion: null,
  placement: "backend",
  riskClass: "collaboration",
  defaultAllowedTools: [],
  toolPolicies: {
    read_item: { approval: "allow", risk: "reviewed-read" },
    blocked: { approval: "disabled", risk: "unknown" },
    unsafe: { approval: "allow", risk: "unknown" },
  },
};

describe("integration policy", () => {
  it("prefers a reviewed read, then an owner read allow, then ask-first", () => {
    expect(approvalFor(descriptor, "read_item", {}, "", { read_item: "ask-first" })).toBe("allow");
    expect(approvalFor(descriptor, "list_unknown", {}, "", { list_unknown: "allow" })).toBe(
      "allow",
    );
    expect(approvalFor(descriptor, "list_unknown", {}, "", { list_unknown: "ask-first" })).toBe(
      "ask-first",
    );
    expect(approvalFor(descriptor, "list_unknown", {})).toBe("ask-first");
  });
  it("never uses owner policies to allow writes, unavailable or disabled tools", () => {
    for (const [id, description] of [
      ["create_item", ""],
      ["get_item", "Read and delete an item"],
      ["opaque", ""],
    ]) {
      expect(approvalFor(descriptor, id!, {}, description, { [id!]: "allow" })).toBe("ask-first");
    }
    expect(approvalFor(descriptor, "blocked", {}, "", { blocked: "allow" })).toBe("disabled");
    expect(
      approvalFor({ ...descriptor, available: false }, "read_item", {}, "", { read_item: "allow" }),
    ).toBe("disabled");
  });
  it.each(["action", "operation", "method", "command"])(
    "keeps the %s argument guard above owner approval",
    (key) => {
      for (const value of ["delete", "unknown", { action: "get" }, null]) {
        expect(
          approvalFor(descriptor, "list_unknown", { [key]: value }, "", { list_unknown: "allow" }),
        ).toBe("ask-first");
      }
      expect(
        approvalFor(descriptor, "list_unknown", { [key]: "get" }, "", { list_unknown: "allow" }),
      ).toBe("allow");
    },
  );
  it("ignores inherited owner policies", () => {
    expect(
      approvalFor(descriptor, "list_unknown", {}, "", Object.create({ list_unknown: "allow" })),
    ).toBe("ask-first");
  });
  it("intersects all three grants and treats empty grants as none", () => {
    expect(effectiveTools(["a", "b", "a", "c"], ["a", "b"], ["a", "c"])).toEqual(["a"]);
    for (const grants of [
      [[], ["a"], ["a"]],
      [["a"], [], ["a"]],
      [["a"], ["a"], []],
    ])
      expect(effectiveTools(grants[0]!, grants[1]!, grants[2]!)).toEqual([]);
  });
  it.each([
    "comment",
    "post",
    "create",
    "merge",
    "deploy",
    "delete",
    "update",
    "transition",
    "trigger",
    "cancel",
  ])("asks for %s in an id or description", (verb) => {
    expect(approvalFor(descriptor, `${verb}_item`, {})).toBe("ask-first");
    expect(approvalFor(descriptor, "read_item", {}, `Read and ${verb} an item`)).toBe("ask-first");
  });
  it("allows only a reviewed read and rejects disabled tools", () => {
    expect(approvalFor(descriptor, "read_item", {})).toBe("allow");
    expect(approvalFor(descriptor, "list_unknown", {})).toBe("ask-first");
    expect(approvalFor(descriptor, "unsafe", {})).toBe("ask-first");
    expect(approvalFor(descriptor, "blocked", {})).toBe("disabled");
    expect(approvalFor({ ...descriptor, available: false }, "read_item", {})).toBe("disabled");
    expect(approvalFor(descriptor, "read_item", { operation: "delete" })).toBe("ask-first");
    expect(approvalFor(descriptor, "read_item", { action: "novel" })).toBe("ask-first");
  });
  it("keeps a space ask above allow rules and automatic review", () => {
    const resolved = resolveActionApprovalDetail({
      toolName: "read_item",
      integrationApproval: "ask-first",
      rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "read_item" }],
    });
    expect(resolved).toMatchObject({ decision: "ask", source: "space_policy" });
    expect(
      planActionGate({
        resolved,
        consequential: true,
        autoReviewEnabled: true,
        checkerConfigured: true,
      }),
    ).toBe("ask");
  });
  it("honors an integration read allow without auto-review while retaining explicit ask rules", () => {
    const resolved = resolveActionApprovalDetail({
      toolName: "synthetic_fetch_item",
      integrationApproval: "allow",
      rules: [],
    });
    expect(resolved).toMatchObject({ decision: "allow", source: "space_policy" });
    expect(
      planActionGate({
        resolved,
        consequential: true,
        autoReviewEnabled: true,
        checkerConfigured: true,
      }),
    ).toBe("allow");
    expect(
      resolveActionApprovalDetail({
        toolName: "synthetic_fetch_item",
        integrationApproval: "allow",
        rules: [
          { effect: "require_approval", matchKind: "tool", matchValue: "synthetic_fetch_item" },
        ],
      }),
    ).toMatchObject({ decision: "ask" });
  });
  it("groups unknown and compound tools conservatively", () => {
    expect(integrationToolKind("get_item", "Read an item")).toBe("read");
    expect(integrationToolKind("get_and_delete", "Read an item")).toBe("write");
    expect(integrationToolKind("opaque", "Unreviewed action")).toBe("write");
  });
});
