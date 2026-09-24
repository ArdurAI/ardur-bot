// @vitest-environment jsdom
import "../test/settings-ui";
import { describe, expect, it } from "vitest";
import { SETTINGS_GROUPS, settingsSections } from "./settings-sections";

describe("settings registry", () => {
  it("keeps stable groups and unique lazy registrations", () => {
    expect(SETTINGS_GROUPS).toEqual(["Settings", "Desktop app", "Customize", "Platform"]);
    expect(new Set(settingsSections.map((item) => item.id)).size).toBe(settingsSections.length);
    for (const item of settingsSections)
      expect(item.component.$$typeof).toBe(Symbol.for("react.lazy"));
  });
  it("hides desktop-only and owner-only settings on the web", () => {
    const web = settingsSections
      .filter((item) => item.available({ desktop: false, isDeploymentOwner: false }))
      .map((item) => item.id);
    expect(web).toEqual(
      expect.arrayContaining([
        "general",
        "account",
        "privacy",
        "capabilities",
        "memory",
        "learning",
        "models",
        "skills",
        "integrations",
        "mcp",
        "plugins",
        "updates",
      ]),
    );
    for (const id of ["system", "extensions", "developer", "computer", "local-api", "connectors"])
      expect(web).not.toContain(id);
    const desktop = settingsSections
      .filter((item) => item.available({ desktop: true, isDeploymentOwner: true }))
      .map((item) => item.id);
    expect(desktop).toEqual(
      expect.arrayContaining(["system", "extensions", "developer", "computer"]),
    );
  });
  it("keeps Integrations and MCP in Customize on every surface", () => {
    for (const id of ["integrations", "mcp"]) {
      const section = settingsSections.find((item) => item.id === id)!;
      expect(section.group).toBe("Customize");
      for (const desktop of [true, false])
        for (const isDeploymentOwner of [true, false])
          expect(section.available({ desktop, isDeploymentOwner })).toBe(true);
    }
  });
});
