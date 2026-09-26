import { localImportServerFixture } from "@ardurbot/testkit/local-import-fixtures";
import { expect, it } from "vitest";
import { mcpServerDto } from "./mcp-server-dto.js";

it("retains import provenance and managed host metadata without exposing credential values", () => {
  const server = mcpServerDto({
    ...localImportServerFixture,
    catalogId: null,
    managedBy: "extension",
    managedId: "fixture-extension",
    placement: "host",
    connectionState: "connected",
    args: ["--token", "fixture-private-value"],
    env: { ACCESS_TOKEN: true },
    headers: {
      Authorization: { name: "ACCESS_TOKEN", bearer: true },
      "X-Workspace": true,
    },
    secretId: null,
    createdAt: new Date(localImportServerFixture.createdAt),
    updatedAt: new Date(localImportServerFixture.updatedAt),
  });
  expect(server).toMatchObject({
    imported: localImportServerFixture.imported,
    managedBy: "extension",
    managedId: "fixture-extension",
    placement: "host",
    connectionState: "connected",
    envKeys: ["ACCESS_TOKEN"],
    headerKeys: ["X-Workspace"],
    hasSecret: false,
    lastError: null,
  });
  expect(JSON.stringify(server)).not.toContain("fixture-private-value");
  expect(
    mcpServerDto({
      ...localImportServerFixture,
      secretId: null,
      lastError: "Could not reach this integration. Try again.",
      createdAt: new Date(localImportServerFixture.createdAt),
      updatedAt: new Date(localImportServerFixture.updatedAt),
    }).lastError,
  ).toBe("Could not reach this integration. Try again.");
});
