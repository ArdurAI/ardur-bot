import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPOSER_MENU_OPTIONS } from "./composer-menu";

describe("native composer menu", () => {
  it("offers files, photos, slash commands and read-only connectors in order", () => {
    expect(COMPOSER_MENU_OPTIONS).toEqual(["Files", "Photos", "Slash commands", "Connectors"]);
  });
  it("uses the native action sheet on iOS and a list sheet elsewhere, without a folder picker", () => {
    const thread = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
    const sheet = readFileSync(
      new URL("../components/composer-sheet.tsx", import.meta.url),
      "utf8",
    );
    expect(thread).toContain("COMPOSER_MENU_OPTIONS.map");
    expect(thread).toContain('setComposerSheet("actions")');
    expect(sheet).toContain('presentationStyle="pageSheet"');
    expect(sheet).toContain("<FlatList");
    expect(sheet).toContain('connection.state === "connected" ? undefined');
    expect(thread).toContain('pathname: "/integrations"');
    expect(sheet).toContain('reducedMotion ? "none" : "slide"');
    expect(sheet).not.toContain("Add folder");
  });
});
