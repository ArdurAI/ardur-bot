import { ORPCError } from "@orpc/client";
import { expect, it } from "vitest";
import { actionMessage } from "./orpc-action-message";

const fallback = "Could not update learning. Try again.";

it("shows the translated fallback for an error the server did not map, whatever its text", () => {
  // What the client receives when a service throws a plain Error, such as a suggestion that was
  // already handled in another tab.
  expect(
    actionMessage(
      new ORPCError("INTERNAL_SERVER_ERROR", { message: "Internal server error", status: 500 }),
      fallback,
    ),
  ).toBe(fallback);
  expect(
    actionMessage(
      new ORPCError("INTERNAL_SERVER_ERROR", { message: "connect ECONNREFUSED", status: 500 }),
      fallback,
    ),
  ).toBe(fallback);
  // A proxy's error page, which the client decodes by status alone.
  expect(actionMessage(new ORPCError("BAD_GATEWAY", { status: 502 }), fallback)).toBe(fallback);
  expect(actionMessage(new ORPCError("TIMEOUT"), fallback)).toBe(fallback);
});

it("shows a sentence the server wrote for people", () => {
  expect(
    actionMessage(
      new ORPCError("FORBIDDEN", { message: "This bot cannot reach this board's computer." }),
      fallback,
    ),
  ).toBe("This bot cannot reach this board's computer.");
  expect(
    actionMessage(
      new ORPCError("BAD_REQUEST", {
        message: "Another write is in progress. Try again in a few seconds.",
      }),
      fallback,
    ),
  ).toBe("Another write is in progress. Try again in a few seconds.");
});

it("falls back when a user-facing code arrives with no sentence of its own", () => {
  expect(actionMessage(new ORPCError("FORBIDDEN"), fallback)).toBe(fallback);
  expect(actionMessage(new ORPCError("UNAUTHORIZED"), fallback)).toBe(fallback);
  expect(actionMessage(new ORPCError("NOT_FOUND", { status: 404 }), fallback)).toBe(fallback);
});

it("falls back for anything that is not a server error", () => {
  expect(actionMessage(new TypeError("Failed to fetch"), fallback)).toBe(fallback);
  expect(actionMessage("not an error", fallback)).toBe(fallback);
});
