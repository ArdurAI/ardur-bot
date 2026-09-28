import { loadBotPresence } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { loadRunBotDirectory } from "./bot-presence-directory.js";

vi.mock("@ardurbot/db", () => ({ loadBotPresence: vi.fn() }));

it("selects room members before applying the desk directory page limit", async () => {
  vi.mocked(loadBotPresence).mockResolvedValue({ bots: [], observedAt: new Date().toISOString() });
  await loadRunBotDirectory(
    {} as never,
    { spaceId: "space", userId: "owner" },
    "worker",
    "room",
    true,
  );
  expect(loadBotPresence).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ groupId: "room", visibleGroupId: "room", callerBotId: "worker" }),
  );
  expect(vi.mocked(loadBotPresence).mock.calls[0]?.[2]?.limit).toBeUndefined();
});
