import type * as Adapters from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { guardComputerTakeover } from "./terminal-takeover.js";

vi.mock("@ardurbot/adapters", async (original) => ({
  ...(await original<typeof Adapters>()),
  withComputerAdmission: vi.fn(async (_db, _computer, work) => work()),
}));
const request = {
  context: { actor: { userId: "user", spaceId: "space", role: "owner" } as Actor },
  input: { botId: "bot" },
};
describe("screen and terminal takeover", () => {
  it.each(["running", "leased", "queued"])(
    "refuses a selected %s bot even on a dedicated computer",
    async (status) => {
      const db = {
        bot: {
          findFirst: async () => ({ id: "bot", computer: { id: "computer", scope: "dedicated" } }),
        },
        run: { findFirst: async () => ({ status }) },
      } as unknown as PrismaClient;
      const handler = vi.fn(async () => ({}));
      await expect(guardComputerTakeover(db, handler)(request)).rejects.toThrow("working");
      expect(handler).not.toHaveBeenCalled();
    },
  );
  it("allows the selected bot explicit takeover request", async () => {
    const db = {
      bot: { findFirst: async () => ({ id: "bot", computer: { id: "computer" } }) },
      run: { findFirst: async () => ({ status: "waiting_takeover" }) },
    } as unknown as PrismaClient;
    const handler = vi.fn(async () => ({ leaseId: "lease" }));
    await expect(guardComputerTakeover(db, handler)(request)).resolves.toEqual({
      leaseId: "lease",
    });
  });
});
