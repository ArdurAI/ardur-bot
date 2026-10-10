import { BoardError, boardContract } from "@ardurbot/contracts/board";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it } from "vitest";
import { boardCall } from "./board.js";
import { deviceReadResponse } from "./device-read-response.js";

it.each(["snapshot", "show"] as const)(
  "preserves the board's denial and error mapping for %s through real RPC",
  async (procedure) => {
    for (const code of ["access_lost", "busy", "command_failed"] as const) {
      const problem = { code, message: "Public fixture board problem." };
      const server = implement({ board: boardContract });
      const handler = new RPCHandler(
        server.router({
          board: {
            [procedure]: server.board[procedure].handler(() =>
              boardCall(async () => {
                throw new BoardError(problem);
              }),
            ),
          },
        } as never),
      );
      const { response } = await handler.handle(
        new Request(`http://fixture.test/rpc/board/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { workspaceId: "board", id: "work-1" } }),
        }),
        { prefix: "/rpc", context: {} },
      );
      expect(response!.status).toBe(code === "access_lost" ? 403 : 400);
      await expect(deviceReadResponse(response, `board/${procedure}`)).rejects.toMatchObject({
        code: code === "access_lost" ? "FORBIDDEN" : "BAD_REQUEST",
        message: problem.message,
        data: problem,
      });
    }
  },
);
it("does not forward unknown errors or private diagnostics", async () => {
  await expect(
    deviceReadResponse(
      Response.json(
        { json: { data: { code: "unknown", message: "private diagnostic" } } },
        { status: 500 },
      ),
      "board/show",
    ),
  ).rejects.toThrow("This view is unavailable");
});
it("returns the existing successful shape unchanged", async () => {
  const body = { items: [], problem: null };
  expect(await deviceReadResponse(Response.json({ json: body }), "board/snapshot")).toEqual(body);
});
