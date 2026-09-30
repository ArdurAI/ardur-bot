import { expect, it } from "vitest";
import { serializeError } from "./serialize-error.js";

it("redacts error names, including repeated names in a circular cause", () => {
  const secret = `xai-${"synthetic".repeat(3)}`;
  const error = new Error(`Failure with ${secret}`);
  error.name = secret;
  error.cause = error;
  const serialized = serializeError(error);
  expect(serialized.name).toBe("[Redacted]");
  expect(serialized.cause?.name).toBe("[Redacted]");
  expect(serialized.cause?.message).toBe("[Circular]");
  expect(JSON.stringify(serialized)).not.toContain(secret);
});
