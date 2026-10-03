import { expect, it } from "vitest";
import {
  HERMES_GRANT_REFUSAL_CATEGORIES,
  HermesProviderRelayError,
  hermesProviderFailure,
  hermesProviderFailureCategory,
} from "./hermes-provider-failure.js";

it.each([401, 403, 429, 500])(
  "preserves HTTP %s across a message-only callback boundary",
  (status) => {
    const original = new HermesProviderRelayError({ kind: "provider-http", status });
    expect(hermesProviderFailure(new Error(original.message))).toEqual({
      kind: "provider-http",
      status,
    });
    expect(hermesProviderFailureCategory(hermesProviderFailure(original))).toBe(
      status === 429
        ? "usage-limit"
        : status < 429
          ? "provider-auth-failed"
          : "provider-request-failed",
    );
  },
);
it.each([
  "profile-unacknowledged",
  "response-limit",
  "request-limit",
  "grant-refused",
  "grant-expired",
  "sequence-changed",
  "disconnected",
  "provider-failed",
] as const)("preserves safe %s across a message-only callback boundary", (kind) => {
  const error = new HermesProviderRelayError({ kind });
  expect(hermesProviderFailure(new Error(error.message))).toEqual({ kind });
});
it("does not copy an unknown error's message, cause, data or status", () => {
  const error = Object.assign(new Error("private fixture prompt with unauthorized and a key"), {
    status: 401,
    data: { body: "private fixture document" },
    cause: new Error("Hermes configuration is not acknowledged."),
  });
  expect(hermesProviderFailure(error)).toEqual({ kind: "provider-failed" });
});

it.each([0, 600, Number.NaN, 401.5, undefined])("rejects invalid HTTP status %s", (status) => {
  expect(
    hermesProviderFailure(new HermesProviderRelayError({ kind: "provider-http", status })),
  ).toEqual({ kind: "provider-failed" });
});
it.each(["__proto__", "constructor", "toString"])(
  "does not classify inherited signature %s",
  (message) => {
    expect(hermesProviderFailure(new Error(message))).toEqual({ kind: "provider-failed" });
  },
);
it("copies only fixed typed failure facts", () => {
  const failure = Object.assign(
    { kind: "response-limit" as const, status: 401 },
    { data: "private fixture" },
  );
  expect(hermesProviderFailure(new HermesProviderRelayError(failure))).toEqual({
    kind: "response-limit",
  });
});

it.each(HERMES_GRANT_REFUSAL_CATEGORIES)(
  "preserves fixed grant category %s across typed and message-only boundaries",
  (category) => {
    const original = new HermesProviderRelayError({ kind: "grant-refused", category });
    const expected = { kind: "grant-refused" as const, category };
    expect(hermesProviderFailure(original)).toEqual(expected);
    expect(hermesProviderFailure(new Error(original.message))).toEqual(expected);
    expect(hermesProviderFailureCategory(expected)).toBe("provider-grant-refused");
  },
);

it.each(["private value", "unknown-field:private_name", "__proto__", "constructor"])(
  "drops an unrecognized grant category %s rather than echoing it",
  (category) => {
    const original = new HermesProviderRelayError({
      kind: "grant-refused",
      category: category as never,
    });
    expect(hermesProviderFailure(original)).toEqual({ kind: "grant-refused" });
    expect(original.message).toBe("Provider request is outside this run's grant.");
    expect(
      hermesProviderFailure(
        new Error(`Provider request is outside this run's grant (${category}).`),
      ),
    ).toEqual({ kind: "provider-failed" });
  },
);

it("does not copy grant category onto another failure kind", () => {
  expect(
    hermesProviderFailure(
      new HermesProviderRelayError({
        kind: "response-limit",
        category: "model",
      }),
    ),
  ).toEqual({ kind: "response-limit" });
});
