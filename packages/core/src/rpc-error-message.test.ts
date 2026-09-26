import { expect, it } from "vitest";
import { rpcErrorMessage } from "./rpc-error-message.js";

const fallback = "Could not update learning. Try again.";

it("decides by the error's code, never by the casing of its text", () => {
  for (const message of ["Internal server error", "Internal Server Error", "ECONNREFUSED"])
    expect(rpcErrorMessage({ code: "INTERNAL_SERVER_ERROR", message }, fallback)).toBe(fallback);
  expect(rpcErrorMessage({ code: "BAD_GATEWAY", message: "Bad Gateway" }, fallback)).toBe(fallback);
  expect(rpcErrorMessage({ message: "Something broke" }, fallback)).toBe(fallback);
});

it("shows a sentence the server wrote for people, and falls back for a bare code", () => {
  const sentence = "This bot cannot reach this board's computer.";
  expect(rpcErrorMessage({ code: "FORBIDDEN", message: sentence }, fallback)).toBe(sentence);
  expect(rpcErrorMessage({ code: "FORBIDDEN", message: "Forbidden" }, fallback)).toBe(fallback);
  expect(rpcErrorMessage({ code: "NOT_FOUND", message: "Not Found" }, fallback)).toBe(fallback);
  expect(rpcErrorMessage({ code: "CONFLICT", message: "" }, fallback)).toBe(fallback);
});
