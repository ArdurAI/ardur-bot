import type { Actor } from "@ardurbot/contracts";
import type { Prisma } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { resolveComposerReferences } from "./composer-references.js";

const actor = { spaceId: "space", userId: "owner" } as Actor;
function fixture(roots = ["/fixture/reports"]) {
  const servers = vi
    .fn()
    .mockResolvedValue([
      { id: "mcp", name: "Reports", catalogId: "reports", connectionState: "connected" },
    ]);
  const registration = vi.fn().mockResolvedValue({ hostRoots: roots });
  const tx = {
    mcpServer: { findMany: servers },
    hostRegistration: { findFirst: registration },
  } as unknown as Prisma.TransactionClient;
  return { tx, servers, registration };
}
describe("composer references", () => {
  it("adds registered folders and owned plugins to prompt and persisted message context", async () => {
    const { tx, servers, registration } = fixture();
    const result = await resolveComposerReferences(
      tx,
      actor,
      [
        { kind: "folder", id: "/fixture/reports" },
        { kind: "mcp", id: "mcp" },
      ],
      "desktop",
    );
    expect(result.note).toContain('Registered folders for this message: ["/fixture/reports"]');
    expect(result.note).toContain('["Reports"]');
    expect(result.blocks).toEqual([
      {
        kind: "card",
        lines: [
          { k: "", v: "/fixture/reports" },
          { k: "", v: "Reports" },
        ],
      },
    ]);
    expect(servers.mock.calls[0]?.[0].where).toMatchObject({
      spaceId: "space",
      userId: "owner",
      enabled: true,
    });
    expect(registration.mock.calls[0]?.[0].where.userId).toBe("owner");
  });
  it("rejects unregistered folders and container computers", async () => {
    const { tx } = fixture();
    await expect(
      resolveComposerReferences(tx, actor, [{ kind: "folder", id: "/fixture/other" }], "desktop"),
    ).rejects.toThrow("Folder is not registered");
    await expect(
      resolveComposerReferences(tx, actor, [{ kind: "folder", id: "/fixture/reports" }], "docker"),
    ).rejects.toThrow("Folders require");
  });
  it("rejects another owner's or disconnected server without changing grants", async () => {
    const { tx, servers } = fixture();
    servers.mockResolvedValueOnce([]);
    await expect(
      resolveComposerReferences(tx, actor, [{ kind: "mcp", id: "other" }]),
    ).rejects.toThrow();
    servers.mockResolvedValueOnce([
      { id: "mcp", name: "Reports", catalogId: "reports", connectionState: "not-connected" },
    ]);
    await expect(
      resolveComposerReferences(tx, actor, [{ kind: "mcp", id: "mcp" }]),
    ).rejects.toThrow();
  });
  it("does no extra lookups for ordinary messages", async () => {
    const { tx, servers, registration } = fixture();
    expect(await resolveComposerReferences(tx, actor, [])).toEqual({ note: "", blocks: [] });
    expect(servers).not.toHaveBeenCalled();
    expect(registration).not.toHaveBeenCalled();
  });
});
