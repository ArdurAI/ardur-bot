import { describe, expect, it } from "vitest";
import { redactBindings, redactSensitiveText } from "./redaction.js";

const sensitiveKeys = [
  "apiKey",
  "api_key",
  "API-KEY",
  "api key",
  "privateKey",
  "PRIVATE_KEY",
  "private-key",
  "private key",
  "accessKey",
  "ACCESS_KEY",
  "access-key",
  "access key",
  "clientKey",
  "CLIENT_KEY",
  "client-key",
  "client key",
  "password",
  "passwd",
  "secret",
  "access_token",
  "credential",
  "authorization",
  "cookie",
];

describe("process diagnostic redaction", () => {
  it.each(sensitiveKeys)(
    "uses the same sensitive-key policy for text and nested bindings: %s",
    (key) => {
      const credential = "made-up-opaque-credential";
      for (const value of [credential, 123456, true, null, [credential], { value: credential }]) {
        const bindings = { nested: { [key]: value, status: "ready" } };
        const expected = { nested: { [key]: "[Redacted]", status: "ready" } };
        expect(redactBindings(bindings)).toEqual(expected);
        expect(JSON.parse(redactSensitiveText(JSON.stringify(bindings)))).toEqual(expected);
      }
    },
  );

  it.each(
    sensitiveKeys.flatMap((key) =>
      ["Basic", "Token", "Fixture.Scheme", "fixture+scheme"].map((scheme) => [key, scheme]),
    ),
  )("redacts an entire scheme credential under %s (%s)", (key, scheme) => {
    const credential = "made-up-opaque-credential";
    const assignment = `${key.includes(" ") ? JSON.stringify(key) : key}=${scheme} ${credential} status=ready`;
    const redacted = redactSensitiveText(assignment);
    expect(redacted).not.toContain(credential);
    expect(redacted).not.toContain(scheme);
    expect(redacted).toContain("status=ready");
    expect(redactSensitiveText(redacted)).toBe(redacted);
  });

  it.each(["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"])(
    "redacts the complete GitHub token family %s",
    (prefix) => {
      const token = `${prefix}${"fixture123".repeat(10)}_fixture456`;
      expect(redactSensitiveText(`before ${token} after`)).toBe("before [Redacted] after");
      expect(redactBindings({ nested: { detail: token } })).toEqual({
        nested: { detail: "[Redacted]" },
      });
    },
  );

  it("preserves credential references and counts consistently", () => {
    const metadata = {
      credentialId: "fixture-reference",
      tokenCount: 7,
      parentSecretAbsent: true,
      configHasKey: false,
    };
    expect(redactBindings(metadata)).toEqual(metadata);
    expect(JSON.parse(redactSensitiveText(JSON.stringify(metadata)))).toEqual(metadata);
  });
});
