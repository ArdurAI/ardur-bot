import type { WorkspaceContext } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { checkedWorkspaceIntent } from "./open-intent";

const context: WorkspaceContext = {
  botId: "bot",
  rootId: "sandbox-computer",
  computerId: "computer",
  generation: 3,
  files: "live",
  runsOnHost: false,
  observedAt: "2026-10-01T00:00:00Z",
};
const target = { botId: "bot", rootId: "sandbox-computer", computerId: "computer", generation: 3 };
describe("workspace navigation intents", () => {
  it.each([
    { view: { type: "ide" }, target, path: "src/main.ts", line: 9 },
    {
      view: { type: "changes" },
      target,
      changeId: "change",
      since: "2026-10-01T00:00:00Z",
      until: "2026-10-02T00:00:00Z",
    },
  ])("selects the matching bot and root without losing the target", (intent) => {
    expect(checkedWorkspaceIntent(intent, "bot", context)).toEqual(intent);
    for (const mismatch of [
      { botId: "other" },
      { rootId: "host-folder" },
      { computerId: "replacement" },
      { generation: 2 },
    ])
      expect(
        checkedWorkspaceIntent({ ...intent, target: { ...target, ...mismatch } }, "bot", context),
      ).toBeNull();
    expect(checkedWorkspaceIntent(intent, "other", context)).toBeNull();
    expect(checkedWorkspaceIntent(intent, "bot", null)).toBeNull();
  });
});
