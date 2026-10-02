import { DelegationAuthoritySchema } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { fixture } from "./delegation-test-fixture.js";

const rows = [
  { name: "host", kind: "desktop", connectionId: null, host: true },
  { name: "legacy Docker", kind: "desktop", connectionId: "docker", host: false },
  { name: "legacy Podman", kind: "desktop", connectionId: "podman", host: false },
  { name: "remote Docker", kind: "remote-docker", connectionId: "docker", host: false },
  { name: "missing connection", kind: "desktop", connectionId: "missing", host: false },
  { name: "empty connection", kind: "desktop", connectionId: "", host: false },
];

describe.each(["coordinator", "worker"])("%s delegation CLI authority", (subject) => {
  it.each(rows)("gates $name", async (row) => {
    const f = fixture();
    f.tx.bot.findFirstOrThrow.mockImplementation(
      async ({ where }) =>
        ({
          ...f.bot,
          id: where.id,
          thread: { id: "worker-thread" },
          computer:
            where.id === subject
              ? { ...row, scope: "team" }
              : { kind: "desktop", connectionId: null, scope: "team" },
        }) as never,
    );
    f.tx.mcpServer.findMany.mockResolvedValue([
      {
        id: "shared",
        enabled: true,
        transport: "host-cli",
        catalogId: null,
        manifest: null,
        spaceAllowedTools: [],
        needsReview: false,
      },
    ] as never);
    const admitted = await f.admit();
    expect(DelegationAuthoritySchema.parse(admitted.authority).connectors).toEqual(
      row.host ? ["mcp:shared", "mcp:shared:read"] : [],
    );
  });
});
