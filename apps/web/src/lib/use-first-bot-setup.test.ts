// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), space: vi.fn(() => "space-a") }));
vi.mock("./rpc", () => ({
  rpc: { bots: { list: api.list, create: api.create } },
  selectedSpaceId: api.space,
}));

import { ensureFirstBot } from "./use-first-bot-setup";

beforeEach(() => vi.clearAllMocks());

describe("first bot setup", () => {
  it("joins concurrent calls and preserves the spawn key", async () => {
    api.list.mockResolvedValue([]);
    api.create.mockResolvedValue({ id: "bot-a" });
    const [first, second] = await Promise.all([ensureFirstBot(), ensureFirstBot()]);
    expect(first).toEqual({ id: "bot-a" });
    expect(second).toEqual(first);
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ spawnKey: "onboarding:first" }),
    );
  });

  it("reads back a committed create after the response fails", async () => {
    api.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "bot-a", name: "Chief", spawnKey: "onboarding:first" }]);
    api.create.mockRejectedValueOnce(new Error("connection lost"));
    expect(await ensureFirstBot()).toEqual({ id: "bot-a" });
  });

  it("re-lists on later visits instead of keeping a deleted bot", async () => {
    api.list
      .mockResolvedValueOnce([{ id: "bot-a", name: "Chief", spawnKey: "onboarding:first" }])
      .mockResolvedValueOnce([]);
    api.create.mockResolvedValue({ id: "bot-b" });
    expect(await ensureFirstBot()).toEqual({ id: "bot-a" });
    expect(await ensureFirstBot()).toEqual({ id: "bot-b" });
    expect(api.create).toHaveBeenCalledOnce();
  });
});
