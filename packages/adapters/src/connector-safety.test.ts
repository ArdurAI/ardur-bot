import { describe, expect, it } from "vitest";
import { redactConnectorPayload } from "./connector-safety.js";

describe("redactConnectorPayload", () => {
  it("redacts secrets that JSON escapes in property names and values", () => {
    const secret = 'api"key42';

    expect(
      redactConnectorPayload(
        {
          [secret]: `prefix ${secret} suffix`,
          nested: { value: secret },
        },
        [secret],
      ),
    ).toEqual({
      "[redacted]": "prefix [redacted] suffix",
      nested: { value: "[redacted]" },
    });
  });

  it("falls back to an inert result when the payload is not JSON serializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(redactConnectorPayload(circular, ["secret"])).toEqual({ ok: true });
  });

  it("redacts short registered credentials in plain response text and primitives", () => {
    expect(redactConnectorPayload("echo ab12cdsuffix", ["ab12cd"])).toBe("echo [redacted]suffix");
    expect(
      redactConnectorPayload({ number: 123, boolean: true, empty: null }, ["123", "true", "null"]),
    ).toEqual({ number: "[redacted]", boolean: "[redacted]", empty: "[redacted]" });
    expect(redactConnectorPayload({ session: "s1", note: "s1" }, ["s1"])).toEqual({
      session: "[redacted]",
      note: "[redacted]",
    });
  });
});
