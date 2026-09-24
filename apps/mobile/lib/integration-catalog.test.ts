import type { IntegrationConnection, IntegrationDescriptor } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";

const integrationCatalog: IntegrationDescriptor[] = ["github", "notion", "example"].map((id) => ({
  id,
  name: id,
  vendor: id,
  available: id !== "example",
  authKind: id === "github" ? "token" : "oauth",
  transport: "remote-http",
  endpoint: "https://example.test/mcp",
  docsUrl: "https://example.test/docs",
  requiredInputs: [],
  verifiedAt: "2026-09-23",
  serverVersion: null,
  placement: "backend",
  riskClass: "collaboration",
  defaultAllowedTools: [],
  toolPolicies: {},
}));

import { integrationCardMessage, loadIntegrationCatalog } from "./integration-catalog";

describe("mobile trusted integration catalog", () => {
  it("loads the shared list and validates its contract", async () => {
    const request = vi.fn(async () => ({
      catalog: integrationCatalog,
      connections: [],
      webUrl: "https://app.example.test",
    }));
    expect((await loadIntegrationCatalog(request)).catalog).toEqual(integrationCatalog);
    expect(request).toHaveBeenCalledWith("integrations/list");
    await expect(loadIntegrationCatalog(async () => [{ slug: "legacy" }])).rejects.toThrow();
  });
  it.each([
    ["awaiting-consent", "Finish signing in in your browser."],
    ["connected", "Your account is connected."],
    ["discovery-failed", "Could not load this account’s tools."],
    ["cancelled", "The connection was cancelled."],
    ["needs-client-registration", "This service needs client registration before you can connect."],
  ] as const)("shows %s with the shared connection state", (state, sentence) => {
    expect(
      integrationCardMessage(integrationCatalog.find((entry) => entry.id === "notion")!, {
        state,
      } as IntegrationConnection),
    ).toBe(sentence);
  });
  it("shows the token path, unavailable cards and pending grant review", () => {
    expect(integrationCardMessage(integrationCatalog[0]!)).toContain("fine-grained token");
    expect(integrationCardMessage(integrationCatalog.find((entry) => !entry.available)!)).toBe(
      "Coming soon",
    );
    expect(
      integrationCardMessage(integrationCatalog[0]!, {
        state: "connected",
        needsReview: true,
      } as IntegrationConnection),
    ).toContain("Review tools");
  });
});
