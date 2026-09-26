import type { TeamRow } from "@ardurbot/contracts";
import { TeamRowSchema } from "@ardurbot/contracts";
import { expect, it, vi } from "vitest";
import { rpc } from "./api";
import { acceptTeamTask, loadTeamRows, mobileTeamRow, stopTeamTask } from "./team";

vi.mock("./api", () => ({ rpc: vi.fn() }));
const row: TeamRow = TeamRowSchema.parse({
  botId: "worker",
  botName: "Reviewer",
  threadId: "thread",
  cursor: 1,
  state: "completed",
  sentence: "Review sources",
  requesterName: "Chief",
  reason: null,
  action: null,
  rootTaskId: "root",
  delegationId: "handoff",
  canStop: false,
  canAccept: true,
  chain: [],
  delegations: [],
  executing: null,
  usage: { tokens: 150, costs: [] },
});
it("renders shared board copy and dispatches Stop and Accept with scoped ids", async () => {
  vi.mocked(rpc).mockResolvedValue({ rows: [row], hostLabel: "This Mac" });
  expect(await loadTeamRows()).toEqual({ rows: [row], hostLabel: "This Mac" });
  expect(mobileTeamRow(row, (text) => text)).toMatchObject({
    name: "Reviewer",
    text: "Done — waiting for your OK",
    stop: false,
    accept: true,
  });
  await acceptTeamTask(row);
  expect(rpc).toHaveBeenLastCalledWith("delegations/accept", { id: "handoff" });
  await stopTeamTask({ ...row, canStop: true });
  expect(rpc).toHaveBeenLastCalledWith("delegations/cancel", { rootTaskId: "root" });
  vi.mocked(rpc).mockClear();
  await stopTeamTask(row);
  await acceptTeamTask({ ...row, canAccept: false });
  expect(rpc).not.toHaveBeenCalled();
});
it("translates a built-in computer name from its key and the deployment's host label", () => {
  const translate = (text: string) => `[${text}]`;
  expect(
    mobileTeamRow({ ...row, computerBuiltin: "host" }, translate, "This Mac").computerName,
  ).toBe("[This Mac]");
  expect(
    mobileTeamRow({ ...row, computerBuiltin: "host" }, translate, "This computer").computerName,
  ).toBe("[This computer]");
  expect(
    mobileTeamRow({ ...row, computerBuiltin: "local-docker" }, translate, "This Mac").computerName,
  ).toBe("[Docker on this Mac]");
  expect(
    mobileTeamRow({ ...row, computerName: "office", computerBuiltin: null }, translate)
      .computerName,
  ).toBe("office");
});
