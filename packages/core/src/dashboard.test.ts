import type { IntegrationCatalogList } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { connectionOverview, sparklinePoints } from "./dashboard.js";

describe("overview projections", () => {
  it("keeps sign-in, discovery errors, disabled servers and revoked devices distinct", () => {
    const integrations = {
      catalog: [],
      connections: [
        { id: "ready", catalogId: "ready", state: "connected" },
        { id: "signin", catalogId: "signin", state: "awaiting-consent" },
        { id: "failed", catalogId: "failed", state: "discovery-failed" },
      ],
    } as unknown as IntegrationCatalogList;
    const rows = connectionOverview({
      integrations,
      servers: [
        { id: "mcp", name: "Tools", enabled: true, oauthStatus: "reconnect" },
        { id: "off", name: "Off", enabled: false, oauthStatus: "none" },
      ],
      devices: [{ id: "phone", deviceName: "Phone", revokedAt: "2026-09-24T00:00:00Z" }],
      channels: [],
    });
    expect(rows.map((row) => row.state)).toEqual([
      "connected",
      "needs-sign-in",
      "error",
      "needs-sign-in",
      "not-connected",
      "not-connected",
    ]);
    expect(rows.every((row) => Object.keys(row).sort().join(",") === "id,kind,name,state")).toBe(
      true,
    );
  });
  it("draws finite sparklines for empty, zero, flat and changing series", () => {
    expect(sparklinePoints([])).toBe("");
    expect(sparklinePoints([0])).toBe("2,30");
    expect(sparklinePoints([0, 10, 0])).toBe("2,30 60,2 118,30");
    expect(sparklinePoints([10, 10])).toBe("2,2 118,2");
  });
  it("shows catalog-backed servers once and uses their current sign-in state", () => {
    const rows = connectionOverview({
      integrations: {
        catalog: [],
        connections: [{ id: "calendar", catalogId: "calendar", state: "connected" }],
      } as unknown as IntegrationCatalogList,
      servers: [{ id: "calendar", name: "Calendar", enabled: true, oauthStatus: "reconnect" }],
      devices: [{ id: "paired", deviceName: "Paired channel", kind: "channel", revokedAt: null }],
      channels: [],
    });
    expect(rows).toEqual([
      { id: "calendar", name: "calendar", kind: "integration", state: "needs-sign-in" },
      { id: "paired", name: "Paired channel", kind: "device", state: "connected" },
    ]);
  });
});
