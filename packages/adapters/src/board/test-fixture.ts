import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BoardRun, BoardWorkspace } from "@ardurbot/contracts/board";
import { BoardRunner } from "@ardurbot/host-runtime/board/runner";
import { BeadsBoardProvider } from "./beads.js";

export async function boardFixture(overrides: NodeJS.ProcessEnv = {}, timeoutMs?: number) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "board-test-")));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  for (const file of ["bd", "responses.json"])
    await copyFile(new URL(`./fixtures/${file}`, import.meta.url), path.join(bin, file));
  await chmod(path.join(bin, "bd"), 0o755);
  const log = path.join(root, "calls.jsonl");
  const runner = new BoardRunner({
    root,
    hostRoots: [root],
    timeoutMs,
    environment: async () => ({
      PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`,
      BOARD_FIXTURE_LOG: log,
      ...overrides,
    }),
  });
  const workspace: BoardWorkspace = {
    id: "workspace",
    kind: "space",
    name: "Board",
    path: path.join(root, "board", "space"),
    prefix: "board",
    enabled: true,
    isDefault: true,
    allowAllBots: true,
    allowedBotIds: [],
    initialized: true,
  };
  // A board is recognized by its settings file, as a real Beads init leaves it.
  await mkdir(path.join(workspace.path, ".beads"), { recursive: true });
  await writeFile(
    path.join(workspace.path, ".beads", "metadata.json"),
    JSON.stringify({ dolt_mode: "embedded" }),
  );
  const requests: BoardRun[] = [];
  const run = (request: BoardRun) => {
    requests.push(request);
    return runner.run(request, "space");
  };
  const provider = new BeadsBoardProvider({ workspace, actor: "Owner", run });
  return {
    root,
    workspace,
    runner,
    provider,
    requests,
    run,
    calls: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; argv: string[] }),
    clean: () => rm(root, { recursive: true, force: true }),
  };
}
