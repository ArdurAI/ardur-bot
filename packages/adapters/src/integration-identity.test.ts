import { describe, expect, it } from "vitest";
import { integrationIdentity, integrationIdentityCall } from "./integration-identity.js";

describe("integration identity inspection", () => {
  it("only invokes a fixed current-user operation that the provider actually advertises", () => {
    expect(integrationIdentityCall("notion", [])).toBeUndefined();
    expect(
      integrationIdentityCall("notion", [
        {
          name: "notion-get-users",
          inputSchema: { properties: { workspace: {} }, required: ["workspace"] },
        },
      ]),
    ).toBeUndefined();
    expect(
      integrationIdentityCall("notion", [
        { name: "notion-get-users", inputSchema: { properties: { user_id: {} } } },
      ]),
    ).toEqual({ name: "notion-get-users", args: { user_id: "self" } });
  });
  it("selects bounded account and workspace fields, stripping stored credential material", () => {
    expect(
      integrationIdentity(
        {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                user: { name: "test-account" },
                workspace: { name: "Test workspace" },
                access_token: "fake-token",
              }),
            },
          ],
        },
        ["fake-token"],
      ),
    ).toEqual({ account: "test-account", workspace: "Test workspace" });
    expect(
      integrationIdentity({ content: [{ type: "text", text: "signed in as an account" }] }, []),
    ).toEqual({ account: null, workspace: null });
    expect(integrationIdentity({ isError: true, content: [] }, [])).toEqual({
      account: null,
      workspace: null,
    });
  });
  it("uses Notion's self metadata for both workspace and current account when advertised", () => {
    expect(
      integrationIdentityCall("notion", [
        { name: "notion-fetch", inputSchema: { properties: { id: {} }, required: ["id"] } },
      ]),
    ).toEqual({ name: "notion-fetch", args: { id: "self" } });
    expect(
      integrationIdentity(
        {
          content: [],
          structuredContent: {
            self: { user: { name: "test-account" }, workspace: { name: "Test workspace" } },
          },
        },
        [],
      ),
    ).toEqual({ account: "test-account", workspace: "Test workspace" });
  });
});
