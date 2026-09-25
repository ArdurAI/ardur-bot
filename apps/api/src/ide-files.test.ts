import type { AgentHomeStore } from "@ardurbot/adapter-kit";
import { FakeSandboxProvider } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { IDE_FILE_BYTES } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { createIdeFiles } from "./ide-files.js";

vi.mock("@ardurbot/db", async (original) => ({
  ...(await original<object>()),
  requireMembership: async (_: unknown, user: string, space: string) => {
    if (user !== "owner" || space !== "space") throw new Error("No membership");
  },
}));
const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};
async function fixture() {
  const sandbox = new FakeSandboxProvider();
  const context = {
    ...actor,
    operationId: "test",
    traceId: "test",
    signal: new AbortController().signal,
  };
  const ref = await sandbox.provision({ botId: "home", homePath: "" }, context);
  const computer = {
    id: "computer",
    spaceId: "space",
    userId: "owner",
    homeKey: "home",
    scope: "team",
    scopeKey: "team:space",
    kind: "fake",
    state: "running",
    providerRef: ref.providerRef,
    maintenanceId: null,
  };
  const db = {
    bot: { findMany: vi.fn(async () => [{ id: "bot", name: "Test", computer }]) },
    computer: { findFirst: vi.fn(async () => computer), updateMany: vi.fn(async () => ({})) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
  };
  const home = { list: vi.fn(async () => []), readFile: vi.fn(), writeFile: vi.fn() };
  const files = createIdeFiles({
    prisma: db as unknown as PrismaClient,
    sandbox,
    home: home as unknown as AgentHomeStore,
  });
  await sandbox.writeFile(
    ref,
    { path: "src/main.ts", content: new TextEncoder().encode("before\n") },
    context,
  );
  const input = { rootId: "sandbox-computer", path: "src/main.ts" };
  return { files, sandbox, computer, db, home, ref, context, input };
}
describe("IDE file operations", () => {
  it("lists just one directory, reads, edits and saves through the selected provider", async () => {
    const f = await fixture();
    expect(await f.files.roots(actor)).toMatchObject([
      { id: f.input.rootId, botId: "bot", computerId: "computer" },
    ]);
    expect(await f.files.list(actor, { ...f.input, path: "" })).toMatchObject([
      { path: "src", kind: "dir" },
    ]);
    expect(await f.files.list(actor, { ...f.input, path: "src" })).toMatchObject([
      { path: "src/main.ts", kind: "file" },
    ]);
    const read = await f.files.read(actor, f.input);
    expect(read).toMatchObject({ content: "before\n", readOnly: false, binary: false });
    expect(
      await f.files.save(actor, {
        ...f.input,
        version: read.version,
        content: "after\n",
        approved: false,
      }),
    ).toMatchObject({ saved: true });
    expect((await f.files.read(actor, f.input)).content).toBe("after\n");
  });
  it.each([
    "../outside",
    "src/../../outside",
    "/absolute",
    "C:/outside",
    "src\\outside",
    "src/\0bad",
  ])("refuses an escaped path %s before the provider", async (path) => {
    const f = await fixture();
    const write = vi.spyOn(f.sandbox, "writeFile");
    await expect(
      f.files.save(actor, {
        ...f.input,
        path,
        version: "a".repeat(64),
        content: "bad",
        approved: true,
      }),
    ).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
  it("does not use another space, a removed root or a computer under maintenance", async () => {
    const f = await fixture();
    await expect(f.files.read({ ...actor, spaceId: "other" }, f.input)).rejects.toThrow(
      "membership",
    );
    await expect(f.files.read(actor, { ...f.input, rootId: "sandbox-other" })).rejects.toThrow();
    f.computer.maintenanceId = "maintenance" as never;
    await expect(f.files.read(actor, f.input)).rejects.toThrow("busy");
  });
  it("requires the same write rule and explicit approval, and detects changed files", async () => {
    const f = await fixture();
    const read = await f.files.read(actor, f.input);
    f.db.actionApprovalRule.findMany.mockResolvedValue([
      { effect: "require_approval", matchKind: "tool", matchValue: "write_file", botId: null },
    ] as never);
    const request = { ...f.input, version: read.version, content: "approved", approved: false };
    expect(await f.files.save(actor, request)).toEqual({ saved: false, approvalRequired: true });
    expect(await f.files.save(actor, { ...request, approved: true })).toMatchObject({
      saved: true,
    });
    expect(await f.files.save(actor, { ...request, approved: true })).toMatchObject({
      saved: false,
      reason: expect.stringContaining("changed"),
    });
  });
  it("previews large files read-only, rejects binary, and enforces bytes instead of UTF-16 length", async () => {
    const f = await fixture();
    await f.sandbox.writeFile(
      f.ref,
      { path: f.input.path, content: new Uint8Array(IDE_FILE_BYTES + 20).fill(97) },
      f.context,
    );
    const large = await f.files.read(actor, f.input);
    expect(large.readOnly).toBe(true);
    expect(large.content.length).toBe(IDE_FILE_BYTES);
    expect(
      await f.files.save(actor, {
        ...f.input,
        content: "é".repeat(IDE_FILE_BYTES),
        version: large.version,
        approved: true,
      }),
    ).toMatchObject({ saved: false });
    await f.sandbox.writeFile(
      f.ref,
      { path: f.input.path, content: new Uint8Array([0, 1, 2]) },
      f.context,
    );
    const binary = await f.files.read(actor, f.input);
    expect(binary).toMatchObject({ binary: true, content: "", readOnly: true });
    expect(
      await f.files.save(actor, {
        ...f.input,
        content: "x",
        version: binary.version,
        approved: true,
      }),
    ).toMatchObject({ saved: false, reason: "Binary file" });
  });
});

it("preserves executable metadata and detects binary data in a stopped home", async () => {
  const f = await fixture();
  vi.spyOn(f.sandbox, "listFiles").mockResolvedValue([
    { path: f.input.path, kind: "file", size: 7, executable: true },
  ]);
  const write = vi.spyOn(f.sandbox, "writeFile");
  const current = await f.files.read(actor, f.input);
  await f.files.save(actor, {
    ...f.input,
    content: "after",
    version: current.version,
    approved: true,
  });
  expect(write).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ executable: true }),
    expect.anything(),
  );
  f.computer.state = "stopped";
  f.home.list.mockResolvedValue([{ path: f.input.path, kind: "file", size: 3 }] as never);
  f.home.readFile.mockRejectedValue(new Error("Binary file"));
  expect(await f.files.read(actor, f.input)).toMatchObject({
    binary: true,
    readOnly: true,
    content: "",
  });
});
