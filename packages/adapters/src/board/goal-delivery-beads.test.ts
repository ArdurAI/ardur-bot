import { readFileSync } from "node:fs";
import type { BoardRun, BoardRunResult, BoardWorkspace } from "@ardurbot/contracts/board";
import { validateBoardArgv } from "@ardurbot/host-runtime/board/argv";
import { expect, it } from "vitest";
import { BeadsBoardProvider } from "./beads.js";
import { goalBoardMarker } from "./goal-delivery-key.js";

const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/responses.json", import.meta.url), "utf8"),
) as {
  show: Array<Record<string, unknown>>;
  update: unknown;
  close: unknown;
  history: unknown;
  "comments add": { id: string; text: string; author: string; created_at: string };
};

const workspace: BoardWorkspace = {
  id: "workspace",
  kind: "space",
  name: "Board",
  path: "/fixture/board",
  prefix: "board",
  enabled: true,
  isDefault: true,
  allowAllBots: true,
  allowedBotIds: [],
  initialized: true,
};

const HASH = "a1b2c3d4e5f60718";

function itemFromRecording() {
  return structuredClone(recorded.show[0]) as Record<string, unknown> & {
    status: string;
    metadata: Record<string, unknown>;
    comments: Array<Record<string, unknown>>;
  };
}

function runner(
  item: ReturnType<typeof itemFromRecording>,
  hooks: {
    onShow?: () => void;
    onHistory?: () => void;
  } = {},
) {
  const calls: string[][] = [];
  const run = async (request: BoardRun) => {
    validateBoardArgv(request.argv);
    calls.push(request.argv);
    const command = request.argv[0];
    if (command === "show") {
      hooks.onShow?.();
      return { ok: true as const, stdout: JSON.stringify([item]) };
    }
    if (command === "history") {
      hooks.onHistory?.();
      return { ok: true as const, stdout: JSON.stringify(null) };
    }
    if (command === "update") return { ok: true as const, stdout: JSON.stringify(recorded.update) };
    if (command === "comments")
      return { ok: true as const, stdout: JSON.stringify(recorded["comments add"]) };
    if (command === "close") {
      item.status = "closed";
      return { ok: true as const, stdout: JSON.stringify(recorded.close) };
    }
    return { ok: true as const, stdout: "null" };
  };
  return { calls, run };
}

function provider(run: (request: BoardRun) => Promise<BoardRunResult>) {
  return new BeadsBoardProvider({ workspace, actor: "Owner", run });
}

function writes(calls: string[][]) {
  return calls.filter((argv) => ["update", "comments", "close"].includes(argv[0] ?? ""));
}

it("delivers against the recorded Beads show array", async () => {
  const item = itemFromRecording();
  const f = runner(item);
  const result = await provider(f.run).deliverKeyed({
    itemId: "board-a",
    hash: HASH,
    generation: 1,
    comment: `${goalBoardMarker(HASH)}\nGoal completed\n/app/g/group?goal=goal&revision=revision`,
    close: false,
    closeReason: "Goal accepted",
  });
  expect(result).toMatchObject({ commented: true, leftOpen: true, closedByThisDelivery: false });
  expect(f.calls.some((argv) => argv[0] === "comments")).toBe(true);
});

it("does not write when the claim expires during the first read", async () => {
  const item = itemFromRecording();
  let expired = false;
  const f = runner(item, {
    onShow: () => {
      expired = true;
    },
  });
  await expect(
    provider(f.run).deliverKeyed({
      itemId: "board-a",
      hash: HASH,
      generation: 1,
      comment: `${goalBoardMarker(HASH)}\nGoal accepted\n/app/g/group?goal=goal&revision=revision`,
      close: true,
      closeReason: "Goal accepted",
      beforeWrite: async () => {
        if (expired) throw new Error("Delivery claim expired");
      },
    }),
  ).rejects.toThrow(/expired/);
  expect(writes(f.calls)).toEqual([]);
});

it("does not close when consent is revoked between the item read and the close", async () => {
  const item = itemFromRecording();
  item.comments = [
    {
      id: "comment-goal",
      author: "Owner",
      text: `${goalBoardMarker(HASH)}\nGoal accepted\n/app/g/group?goal=goal&revision=revision`,
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  const f = runner(item, {
    onHistory: () => {
      item.metadata.ardur_close_when_done = false;
    },
  });
  const result = await provider(f.run).deliverKeyed({
    itemId: "board-a",
    hash: HASH,
    generation: 1,
    comment: `${goalBoardMarker(HASH)}\nGoal accepted\n/app/g/group?goal=goal&revision=revision`,
    close: true,
    closeReason: "Goal accepted",
  });
  expect(f.calls.filter((argv) => argv[0] === "close")).toEqual([]);
  expect(result.leftOpen).toBe(true);
  expect(result.closedByThisDelivery).toBe(false);
});

it("does not close an item the owner reopened when the ledger already records the close", async () => {
  const item = itemFromRecording();
  item.status = "open";
  item.metadata[`ardur_gd_${HASH}`] = "1:c1:x1";
  item.comments = [
    {
      id: "comment-goal",
      author: "Owner",
      text: `${goalBoardMarker(HASH)}\nGoal accepted\n/app/g/group?goal=goal&revision=revision`,
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  const f = runner(item);
  const result = await provider(f.run).deliverKeyed({
    itemId: "board-a",
    hash: HASH,
    generation: 2,
    comment: `${goalBoardMarker(HASH)}\nGoal accepted\n/app/g/group?goal=goal&revision=revision`,
    close: true,
    closeReason: "Goal accepted",
  });
  expect(f.calls.filter((argv) => argv[0] === "close")).toEqual([]);
  expect(result.closedByThisDelivery).toBe(false);
  expect(result.leftOpen).toBe(true);
});

it("does not close again after a committed close response is lost and the owner reopens the item", async () => {
  const item = itemFromRecording();
  let loseClose = true;
  let history: unknown = recorded.history;
  const calls: string[][] = [];
  const run = async (request: BoardRun) => {
    validateBoardArgv(request.argv);
    calls.push(request.argv);
    const command = request.argv[0];
    if (command === "show") return { ok: true as const, stdout: JSON.stringify([item]) };
    if (command === "history") return { ok: true as const, stdout: JSON.stringify(history) };
    if (command === "update") {
      for (let index = 0; index < request.argv.length; index += 1) {
        if (request.argv[index] !== "--set-metadata") continue;
        const arg = request.argv[index + 1] ?? "";
        const eq = arg.indexOf("=");
        item.metadata[arg.slice(0, eq)] = arg.slice(eq + 1);
      }
      return { ok: true as const, stdout: JSON.stringify(recorded.update) };
    }
    if (command === "comments") {
      item.comments.push({
        id: recorded["comments add"].id,
        author: recorded["comments add"].author,
        text: request.argv.at(-1),
        created_at: recorded["comments add"].created_at,
      });
      return { ok: true as const, stdout: JSON.stringify(recorded["comments add"]) };
    }
    if (command === "close") {
      item.status = "closed";
      if (loseClose) {
        loseClose = false;
        return {
          ok: false as const,
          problem: { code: "timeout" as const, message: "response lost" },
        };
      }
      return { ok: true as const, stdout: JSON.stringify(recorded.close) };
    }
    return { ok: true as const, stdout: "null" };
  };
  const input = {
    itemId: "board-a",
    hash: HASH,
    generation: 1,
    comment: `${goalBoardMarker(HASH)}\nGoal accepted\n/app/g/group?goal=goal&revision=revision`,
    close: true,
    closeReason: "Goal accepted",
  };
  await expect(provider(run).deliverKeyed(input)).rejects.toThrow(/response lost/);
  item.status = "open";
  await expect(provider(run).deliverKeyed({ ...input, generation: 2 })).rejects.toThrow(
    /uncertain/,
  );
  history = [
    {
      CommitDate: "2026-01-02T00:00:00Z",
      Issue: { status: "closed", close_reason: "Goal accepted" },
    },
  ];
  const retry = await provider(run).deliverKeyed({ ...input, generation: 2 });
  expect(calls.filter((argv) => argv[0] === "close")).toHaveLength(1);
  expect(item.status).toBe("open");
  expect(item.metadata[`ardur_gd_${HASH}`]).toBe("2:c1:x3");
  expect(retry.closedByThisDelivery).toBe(false);
  expect(retry.leftOpen).toBe(true);
});

it("does not close an open item whose history shows this delivery already closed it", async () => {
  const item = itemFromRecording();
  item.status = "open";
  item.metadata[`ardur_gd_${HASH}`] = "1:c1:x0";
  item.comments = [
    {
      id: "comment-goal",
      author: "Owner",
      text: `${goalBoardMarker(HASH)}\nGoal accepted\n/app/g/group?goal=goal&revision=revision`,
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  const calls: string[][] = [];
  const run = async (request: BoardRun) => {
    validateBoardArgv(request.argv);
    calls.push(request.argv);
    const command = request.argv[0];
    if (command === "show") return { ok: true as const, stdout: JSON.stringify([item]) };
    if (command === "history") {
      return {
        ok: true as const,
        stdout: JSON.stringify([
          {
            CommitHash: "reopen-1",
            Committer: "Owner",
            CommitDate: "2026-01-03T00:00:00Z",
            Issue: { status: "open", title: "Prepare schema", close_reason: "" },
          },
          {
            CommitHash: "close-1",
            Committer: "Owner",
            CommitDate: "2026-01-02T00:00:00Z",
            Issue: { status: "closed", title: "Prepare schema", close_reason: "Goal accepted" },
          },
        ]),
      };
    }
    if (command === "update") return { ok: true as const, stdout: JSON.stringify(recorded.update) };
    if (command === "close") {
      item.status = "closed";
      return { ok: true as const, stdout: JSON.stringify(recorded.close) };
    }
    return { ok: true as const, stdout: "null" };
  };
  const result = await provider(run).deliverKeyed({
    itemId: "board-a",
    hash: HASH,
    generation: 2,
    comment: `${goalBoardMarker(HASH)}\nGoal accepted\n/app/g/group?goal=goal&revision=revision`,
    close: true,
    closeReason: "Goal accepted",
  });
  expect(calls.filter((argv) => argv[0] === "close")).toEqual([]);
  expect(item.status).toBe("open");
  expect(result.closedByThisDelivery).toBe(false);
  expect(result.leftOpen).toBe(true);
});
