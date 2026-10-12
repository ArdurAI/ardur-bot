import { expect, it } from "vitest";
import { validateBoardArgv } from "./argv.js";

it("admits only the bounded commented close-intent metadata", () => {
  const command = (value: string) => ["update", "board-a", "--set-metadata", value];
  expect(validateBoardArgv(command("ardur_gd_a1b2c3d4e5f60718=1:c1:x4"))).toEqual({
    write: true,
  });
  for (const value of [
    "ardur_gd_a1b2c3d4e5f60718=1:c0:x4",
    "ardur_gd_a1b2c3d4e5f60718=1:c1:x5",
    "ardur_gd_a1b2c3d4e5f60718=0:c1:x4",
    "ardur_gd_a1b2c3d4e5f60718=1000000000:c1:x4",
    "ardur_gd_a1b2c3d4e5f60718=1:c1:x4;close",
    "ardur_gd_invalid=1:c1:x4",
    "unrelated=1:c1:x4",
  ]) {
    expect(() => validateBoardArgv(command(value))).toThrow(/not allowed/);
  }
  expect(() =>
    validateBoardArgv(["close", "board-a", "--set-metadata", "ardur_gd_a1b2c3d4e5f60718=1:c1:x4"]),
  ).toThrow(/not allowed/);
});
