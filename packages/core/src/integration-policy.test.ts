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
  it("groups unknown and compound tools conservatively", () => {
    expect(integrationToolKind("get_item", "Read an item")).toBe("read");
    expect(integrationToolKind("get_and_delete", "Read an item")).toBe("write");
    expect(integrationToolKind("opaque", "Unreviewed action")).toBe("write");
  });
});
