import { expect, it } from "vitest";
import { errorDataCode } from "./rpc-error.js";

it("reads the code an ORPC error carries in its data", () => {
  expect(errorDataCode({ data: { code: "engine-missing" } })).toBe("engine-missing");
  expect(errorDataCode({ message: "Could not save." })).toBeUndefined();
  expect(errorDataCode({ data: {} })).toBeUndefined();
  expect(errorDataCode(null)).toBeUndefined();
  expect(errorDataCode("nope")).toBeUndefined();
});
