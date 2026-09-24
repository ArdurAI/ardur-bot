import { expect, it } from "vitest";
import { terminalInput } from "./input.js";

it("encodes ordinary input as UTF-8 and binary input byte for byte", () => {
  expect(terminalInput("é")).toEqual(Uint8Array.of(0xc3, 0xa9));
  expect(terminalInput("\x00\x80\xff", true)).toEqual(Uint8Array.of(0, 128, 255));
});
