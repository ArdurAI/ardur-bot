import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { boardNotificationTarget } from "./board-notifications";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";

vi.mock("expo-notifications", () => ({}));
vi.mock("expo-router", () => ({ useRouter: vi.fn() }));
vi.mock("./api", () => ({ selectSpace: vi.fn() }));
it("keeps home navigation to Dashboard, Bots and native Files with Board under Overview", () => {
  const home = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
  for (const label of ["Dashboard", "Bots", "Files"])
    expect(home).toContain(`accessibilityLabel={t("${label}")}`);
  expect(home).not.toContain('accessibilityLabel={t("Board")}');
  expect(readFileSync(new URL("../app/overview.tsx", import.meta.url), "utf8")).toContain(
    'import("../components/board-view")',
  );
  expect(readFileSync(new URL("../app/account.tsx", import.meta.url), "utf8")).toContain(
    'router.push("/boards-settings")',
  );
});
it("accepts only complete Board notification targets", () => {
  expect(
    boardNotificationTarget({ board: { spaceId: "space", workspaceId: "board", itemId: "item" } }),
  ).toEqual({ spaceId: "space", workspace: "board", item: "item" });
  for (const board of [null, "bad", {}, { spaceId: "space", workspaceId: "board", itemId: 1 }])
    expect(boardNotificationTarget({ board })).toBeNull();
});
it("translates every new Board, setup and Files string in both mobile catalogs", () => {
  const strings = [
    "Bots",
    "Ready",
    "In progress",
    "Blocked",
    "Deferred",
    "Done",
    "Search",
    "Label",
    "Assignee",
    "Bot",
    "Blocks",
    "Blocked by",
  ];
  for (const path of [
    "../components/board-view.tsx",
    "../app/boards-settings.tsx",
    "../app/ide.tsx",
    "../app/overview.tsx",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    strings.push(
      ...[...source.matchAll(/\bt\(\s*"((?:\\.|[^"\\])*)"/g)].map(
        (match) => JSON.parse(`"${match[1]}"`) as string,
      ),
    );
  }
  for (const messages of [RU_MESSAGES, ZH_MESSAGES])
    expect([...new Set(strings)].filter((key) => !messages[key]?.trim())).toEqual([]);
});
