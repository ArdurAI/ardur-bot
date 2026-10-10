import type { Actor, RuntimeComputerLocation } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceFiles } from "./workspace-files.js";
import { createWorkspaceGit } from "./workspace-git.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};

function fixture(options: { gitChanges?: boolean } = {}) {
  const computer = {
    id: "computer",
    screenGeneration: 2,
    kind: "docker",
    connectionId: null as string | null,
    connectionSettings: null as RuntimeComputerLocation["connectionSettings"],
    scope: "team",
    homeKey: "home",
    homeRevision: "saved",
    state: "running",
    providerRef: "provider-ref",
    maintenanceId: null,
  };
  const db = {
    bot: {
      findFirst: vi.fn(
        async ({ where }: { where: { userId: string; spaceId: string; id: string } }) =>
          where.userId === actor.userId && where.spaceId === actor.spaceId && where.id === "bot"
            ? { id: "bot", computer }
            : null,
      ),
    },
  };
  const sandbox: Record<string, unknown> = {};
  if (options.gitChanges !== false) {
    sandbox.gitChanges = vi.fn(async () => ({
      kind: "status",
      head: "a".repeat(40),
      entries: [
        { path: "app.ts", staged: true, unstaged: false, untracked: false, conflict: false },
      ],
      truncated: false,
    }));
  }
  const files = createWorkspaceFiles({
    sandbox,
    home: {},
    prisma: db,
  } as unknown as Parameters<typeof createWorkspaceFiles>[0]);
  const git = createWorkspaceGit({ sandbox: sandbox as never, files });
  const input = { botId: "bot", computerId: "computer", generation: 2 };
  return { computer, sandbox, files, git, input };
}

describe("workspace git observation", () => {
  it("describes the capability only when the provider observes git", async () => {
    const supported = fixture();
    expect(await supported.files.describe(actor, "bot")).toMatchObject({
      files: "live",
      git: true,
    });
    const unsupported = fixture({ gitChanges: false });
    expect(await unsupported.files.describe(actor, "bot")).toMatchObject({
      files: "live",
      git: false,
    });
    const result = await unsupported.git.observe(actor, unsupported.input);
    expect(result).toMatchObject({ status: "unavailable" });
    expect(Object.keys(unsupported.sandbox)).toHaveLength(0);
  });

  it("maps a provider status observation into the contract", async () => {
    const f = fixture();
    const result = await f.git.observe(actor, f.input);
    expect(result).toEqual({
      context: expect.objectContaining({
        botId: "bot",
        computerId: "computer",
        generation: 2,
        files: "live",
        git: true,
        rootId: "sandbox-computer",
      }),
      status: "ok",
      head: "a".repeat(40),
      entries: [
        { path: "app.ts", staged: true, unstaged: false, untracked: false, conflict: false },
      ],
    });
    const observe = f.sandbox.gitChanges as ReturnType<typeof vi.fn>;
    expect(observe).toHaveBeenCalledTimes(1);
    const [ref, request, context] = observe.mock.calls[0]!;
    expect(ref).toMatchObject({ id: "provider-ref" });
    expect(request).toEqual({});
    expect(context).toMatchObject({ botId: "bot", userId: actor.userId, spaceId: actor.spaceId });
  });

  it("maps a provider diff observation into the contract", async () => {
    const f = fixture();
    (f.sandbox.gitChanges as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "diff",
      before: "old",
      after: "new",
      binary: false,
      truncated: true,
    });
    const result = await f.git.observe(actor, { ...f.input, path: "app.ts" });
    expect(result.status).toBe("ok");
    expect(result.diff).toEqual({
      path: "app.ts",
      before: "old",
      after: "new",
      binary: false,
      truncated: true,
    });
    const observe = f.sandbox.gitChanges as ReturnType<typeof vi.fn>;
    expect(observe.mock.calls[0]![1]).toEqual({ path: "app.ts" });
  });

  it("propagates not-repository and bounded listings", async () => {
    const f = fixture();
    const observe = f.sandbox.gitChanges as ReturnType<typeof vi.fn>;
    observe.mockResolvedValue({ kind: "not-repository" });
    expect(await f.git.observe(actor, f.input)).toMatchObject({ status: "not-repository" });
    observe.mockResolvedValue({
      kind: "status",
      head: null,
      entries: [],
      truncated: true,
    });
    expect(await f.git.observe(actor, f.input)).toMatchObject({ status: "ok", truncated: true });
  });

  it("refuses another bot's root before the provider is called", async () => {
    const f = fixture();
    await expect(f.git.observe(actor, { ...f.input, rootId: "sandbox-other" })).rejects.toThrow(
      "Resource not found",
    );
    await expect(
      f.git.observe(actor, { ...f.input, rootId: "sandbox-computer" }),
    ).resolves.toMatchObject({ status: "ok" });
  });

  it("fences a stale generation or a replaced computer", async () => {
    const f = fixture();
    await expect(f.git.observe(actor, { ...f.input, generation: 1 })).rejects.toThrow(
      "Computer changed. Refresh files.",
    );
    await expect(f.git.observe(actor, { ...f.input, computerId: "other" })).rejects.toThrow(
      "Computer changed. Refresh files.",
    );
    expect(f.sandbox.gitChanges).not.toHaveBeenCalled();
  });

  it("fences a bot outside the actor's space", async () => {
    const f = fixture();
    await expect(f.git.observe({ ...actor, userId: "someone-else" }, f.input)).rejects.toThrow(
      "Resource not found",
    );
    expect(f.sandbox.gitChanges).not.toHaveBeenCalled();
  });

  it("refuses saved and unavailable file states", async () => {
    const f = fixture();
    f.computer.state = "stopped";
    await expect(f.git.observe(actor, f.input)).rejects.toThrow(
      "Git changes are unavailable on this computer.",
    );
    expect(f.sandbox.gitChanges).not.toHaveBeenCalled();
  });

  it("rejects traversal and metadata paths before the provider sees them", async () => {
    const f = fixture();
    await expect(f.git.observe(actor, { ...f.input, path: "../escape.md" })).rejects.toThrow(
      "Path escapes registered folders.",
    );
    await expect(f.git.observe(actor, { ...f.input, path: ".git/config" })).rejects.toThrow(
      "Path escapes registered folders.",
    );
    expect(f.sandbox.gitChanges).not.toHaveBeenCalled();
  });
});
