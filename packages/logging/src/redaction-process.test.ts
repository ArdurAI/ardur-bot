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
  "authKey",
  "auth_key",
  "AUTH-KEY",
  "auth key",
  "password",
  "passwd",
  "secret",
  "access_token",
  "credential",
  "authorization",
  "cookie",
];

describe("process diagnostic redaction", () => {
  it.each(["dGVzdDp0ZXN0==", "user:pass-part"])(
    "redacts punctuation inside a scheme credential: %s",
    (credential) => {
      for (const scheme of ["Bearer", "Basic", "Token", "Fixture.Scheme"]) {
        for (const [input, expected] of [
          [`Authorization: ${scheme} ${credential}`, "Authorization: [Redacted]"],
          [`access_token=${scheme} ${credential}`, "access_token=[Redacted]"],
          [
            `?access_token=${scheme} ${credential}&scope=read`,
            "?access_token=[Redacted]&scope=read",
          ],
        ]) {
          const redacted = redactSensitiveText(input!);
          expect(redacted).toBe(expected);
          expect(redactSensitiveText(redacted)).toBe(redacted);
        }
      }
    },
  );

  it.each(["authKey", "auth_key"])("redacts the review auth-key assignment: %s", (key) => {
    const credential = "madeup-authKey-value";
    expect(redactSensitiveText(`${key}=${credential}`)).toBe(`${key}=[Redacted]`);
    expect(redactBindings({ [key]: credential })).toEqual({ [key]: "[Redacted]" });
  });

  it("preserves an ordinary spaced assignment after a sensitive value", () => {
    expect(redactSensitiveText("password=fixture-value status = ready")).toBe(
      "password=[Redacted] status = ready",
    );
  });

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
