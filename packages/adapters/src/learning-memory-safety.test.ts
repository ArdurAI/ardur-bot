import { expect, it } from "vitest";
import { assertSafeMemoryContent } from "./learning-memory-safety.js";

it("masks the entire detected credential after other fields are redacted", () => {
  expect(() =>
    assertSafeMemoryContent("- ck_ExampleCredential123 belongs to user@example.test", []),
  ).toThrow();
  try {
    assertSafeMemoryContent("- ck_ExampleCredential123 belongs to user@example.test", []);
  } catch (error) {
    expect(error).toMatchObject({
      lineNumber: 1,
      maskedLine: "- [Redacted] belongs to [Redacted]",
    });
  }
});

it("suppresses a line when the detector still rejects the masked result", () => {
  const line = "user@example.test [redacted]";
  expect(() => assertSafeMemoryContent(line, ["[redacted]"])).toThrow();
  try {
    assertSafeMemoryContent(line, ["[redacted]"]);
  } catch (error) {
    expect(error).toMatchObject({
      lineNumber: 1,
      maskedLine: "contains something that looks like a credential",
    });
  }
});
