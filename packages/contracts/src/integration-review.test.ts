import { describe, expect, it } from "vitest";
import { integrationToolsNeedReview } from "./integration-catalog.js";

describe("connected tool access", () => {
  const connection = { spaceAllowedTools: ["read"], needsReview: false };
  it("does not mislabel allowed tools", () => {
    expect(integrationToolsNeedReview(connection, { access: "custom", toolIds: ["read"] })).toBe(
      false,
    );
    expect(integrationToolsNeedReview(connection, { access: "inherit" })).toBe(false);
  });
  it("shows an empty bot list and an empty space list", () => {
    expect(integrationToolsNeedReview(connection, { access: "custom", toolIds: [] })).toBe(true);
    expect(integrationToolsNeedReview({ spaceAllowedTools: [] })).toBe(true);
    expect(integrationToolsNeedReview(connection, { access: "custom", toolIds: ["other"] })).toBe(
      true,
    );
  });
  it("shows pending review even with a prior list", () => {
    expect(
      integrationToolsNeedReview(connection, {
        access: "custom",
        toolIds: ["read"],
        needsReview: true,
      }),
    ).toBe(true);
    expect(integrationToolsNeedReview({ ...connection, needsReview: true })).toBe(true);
    expect(integrationToolsNeedReview(connection, { access: "none" })).toBe(false);
  });
});
