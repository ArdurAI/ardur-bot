import { readFileSync } from "node:fs";
import type { BoardRun, BoardRunResult, BoardWorkspace } from "@ardurbot/contracts/board";
import { validateBoardArgv } from "@ardurbot/host-runtime/board/argv";
import { BeadsBoardProvider } from "./beads.js";

const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/responses.json", import.meta.url), "utf8"),
) as {
  show: Array<Record<string, unknown>>;
  update: unknown;
  close: unknown;
  history: unknown;
  "comments add": { id: string; author: string; created_at: string };
};

export const goalBoardFixtureWorkspace: BoardWorkspace = {
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

/** Persist mutations across provider restarts, using recorded responses and host validation. */
export function goalBoardFixture() {
  const item = structuredClone(recorded.show[0]) as Record<string, unknown> & {
    status: string;
    metadata: Record<string, unknown>;
    comments: Array<Record<string, unknown>>;
  };
  const calls: BoardRun[] = [];
  const state = {
    history: structuredClone(recorded.history),
    beforeCommand: undefined as ((request: BoardRun) => void) | undefined,
    close: undefined as (() => BoardRunResult) | undefined,
  };
  const run = async (request: BoardRun): Promise<BoardRunResult> => {
    validateBoardArgv(request.argv);
    calls.push(request);
    state.beforeCommand?.(request);
    switch (request.argv[0]) {
      case "show":
        return { ok: true, stdout: JSON.stringify([item]) };
      case "history":
        return { ok: true, stdout: JSON.stringify(state.history) };
      case "update": {
        for (let index = 0; index < request.argv.length; index++) {
          if (request.argv[index] === "--set-metadata") {
            const value = request.argv[++index]!;
            const eq = value.indexOf("=");
            item.metadata[value.slice(0, eq)] = value.slice(eq + 1);
          }
          if (request.argv[index] === "--status") item.status = request.argv[++index]!;
        }
        return { ok: true, stdout: JSON.stringify(recorded.update) };
      }
      case "comments": {
        const comment = {
          ...recorded["comments add"],
          id: `comment-${item.comments.length + 1}`,
          text: request.argv.at(-1),
        };
        item.comments.push(comment);
        return { ok: true, stdout: JSON.stringify(comment) };
      }
      case "close":
        if (state.close) return state.close();
        item.status = "closed";
        return { ok: true, stdout: JSON.stringify(recorded.close) };
      default:
        throw new Error("Unexpected fixture command");
    }
  };
  return {
    item,
    calls,
    state,
    run,
    provider: (workspace = goalBoardFixtureWorkspace) =>
      new BeadsBoardProvider({ workspace, actor: "Owner", run }),
    writes: () => calls.filter(({ argv }) => validateBoardArgv(argv).write),
    closes: () => calls.filter(({ argv }) => argv[0] === "close"),
  };
}
