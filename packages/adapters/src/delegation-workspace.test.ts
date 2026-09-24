import type { AdapterContext, ComputerRef, SandboxProvider } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { prepareDelegationWorkspace } from "./delegation-workspace.js";

it("creates a durable task-owned workspace through positional sandbox arguments and reuses it", async () => {
  const row = { rootTaskId: "root", workspacePath: null as string | null };
  const update = vi.fn(async ({ data }) => {
    row.workspacePath = data.workspacePath;
  });
  const execute = vi.fn(async function* (_computer: ComputerRef, _input: { argv: string[] }) {
    yield { type: "stdout", data: "worktree" };
    yield { type: "exit", code: 0 };
  });
  const db = {
    delegation: { findUniqueOrThrow: vi.fn(async () => row), update },
  } as unknown as PrismaClient;
  const sandbox = { execute } as unknown as SandboxProvider;
  const context = {} as AdapterContext,
    computer = {} as ComputerRef;
  const source = "repo with spaces";
  expect(await prepareDelegationWorkspace(db, sandbox, computer, context, "handoff", source)).toBe(
    "tasks/root/handoff",
  );
  expect(update).toHaveBeenCalledWith({
    where: { id: "handoff" },
    data: { workspacePath: "tasks/root/handoff", workspaceKind: "worktree" },
  });
  expect(execute.mock.calls[0]?.[1]).toMatchObject({
    argv: ["bash", "-c", expect.any(String), "task-workspace", source, "tasks/root/handoff"],
  });
  await prepareDelegationWorkspace(db, sandbox, computer, context, "handoff", source);
  expect(execute).toHaveBeenCalledOnce();
});
