import type { Actor, RunActivityRow } from "@ardurbot/contracts";
import { DashboardNowSchema } from "@ardurbot/contracts/dashboard";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { dashboardNow } from "./dashboard.js";
import { listSpaceRuns } from "./runs.js";
import { teamBoard } from "./team.js";

vi.mock("./runs.js", () => ({ listSpaceRuns: vi.fn() }));
vi.mock("./team.js", () => ({ teamBoard: vi.fn() }));
const actor = { userId: "viewer", spaceId: "space" } as Actor;
function run(runId: string, extra: Partial<RunActivityRow> = {}): RunActivityRow {
  return {
    runId,
    botId: "bot",
    botName: "Reviewer",
    threadId: "thread",
    groupId: null,
    groupName: null,
    status: "waiting_input",
    trigger: "user",
    notificationsEnabled: false,
    promptSnippet: "Review",
    updatedAt: "2026-09-24T00:00:00Z",
    ...extra,
  };
}
function ask(runId: string) {
  return {
    id: `card-${runId}`,
    runId,
    blocks: [
      {
        kind: "ask",
        status: "pending",
        text: `Approve ${runId}?`,
        approvalEffectId: `effect-${runId}`,
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      },
    ],
  };
}
it.each([null, "group"])(
  "reads all waiting runs and their complete approval history, including coordinator %s",
  async (groupId) => {
    const runs = [
      run("older"),
      run("newer"),
      run("external", { threadId: "external-thread", externalThread: true }),
      run("delegated", {
        threadId: "worker-thread",
        approvalTarget: { botId: "coordinator", threadId: "coordinator-thread", groupId },
      }),
      run("finished", { status: "completed" }),
    ];
    const messages = [
      ...runs.slice(0, 4).map((run) => ask(run.runId)),
      { ...ask("answered"), blocks: [{ ...ask("answered").blocks[0]!, status: "answered" }] },
      {
        id: "input",
        runId: "older",
        blocks: [{ kind: "ask", text: "Which file?", status: "pending" }],
      },
      { id: "invalid", runId: "older", blocks: [{ kind: "unknown" }] },
      ...Array.from({ length: 110 }, (_, index) => ({
        id: `later-${index}`,
        runId: "newer",
        blocks: [{ kind: "text", text: "Progress" }],
      })),
    ];
    vi.mocked(listSpaceRuns).mockResolvedValue(runs);
    vi.mocked(teamBoard).mockResolvedValue({ rows: [] });
    const findMany = vi.fn(async ({ take }: { take?: number }) =>
      take ? messages.slice(-take) : messages,
    );
    const prisma = { message: { findMany } } as unknown as PrismaClient;
    const summary = await dashboardNow(prisma, actor);
    expect(summary.approvals.map((approval) => [approval.runId, approval.messageId])).toEqual([
      ["older", "card-older"],
      ["newer", "card-newer"],
      ["external", "card-external"],
      ["delegated", "card-delegated"],
    ]);
    expect(DashboardNowSchema.parse(summary)).toEqual(summary);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        thread: { userId: "viewer", spaceId: "space" },
        role: "bot",
        OR: [
          { runId: "older", threadId: "thread" },
          { runId: "newer", threadId: "thread" },
          { runId: "external", threadId: "external-thread" },
          { runId: "delegated", threadId: "coordinator-thread" },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, runId: true, blocks: true },
    });
    expect(listSpaceRuns).toHaveBeenCalledWith(prisma, actor, "active");
    expect(teamBoard).toHaveBeenCalledWith(prisma, actor);
  },
);
it("does not query conversations when no run is waiting", async () => {
  vi.mocked(listSpaceRuns).mockResolvedValue([run("running", { status: "running" })]);
  vi.mocked(teamBoard).mockResolvedValue({ rows: [] });
  const findMany = vi.fn();
  const result = await dashboardNow({ message: { findMany } } as unknown as PrismaClient, actor);
  expect(result.approvals).toEqual([]);
  expect(findMany).not.toHaveBeenCalled();
});
