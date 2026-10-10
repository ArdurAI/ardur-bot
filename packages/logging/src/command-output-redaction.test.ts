import { describe, expect, it } from "vitest";
import {
  redactBindings,
  redactCommandOutput,
  redactCredentialText,
  redactSensitiveText,
} from "./redaction.js";

// Source fixtures: memory/briefs/maintenance.ts, adapters/run-model-pin.test.ts,
// adapters/comparison.ts and the command-redaction issue's identifier/call examples.
const sourceLines = [
  "    knownSecrets: secrets,",
  "const tokenCount = usage.total",
  "      maxTokens: 4096,",
  "secretStore.read(id)",
  "    tokens: number;",
  "secretStore: this.secretStore,",
  "signingKey: configuration.signingKey,",
  "githubPat: readPat(configuration.connection),",
  "authCode: number;",
  "knownSecrets: configuration.managedEnvironment.secrets,",
  "token: readToken(configuration.connection),",
  "token: readToken(id),",
  "token =",
  "secret = <placeholder>",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal documentation placeholder.
  "secret = ${MANAGED_SECRET}",
];
const credentials = [
  [
    "privateKey=-----BEGIN PRIVATE KEY-----\nFAKE-KEY-FIXTURE\n-----END PRIVATE KEY-----",
    "privateKey=[Redacted]",
  ],
  ['token = "ghp_fixtureOnlyNotARealCredential1234567890"', 'token = "[Redacted]"'],
  ["password: 'hunter2'", "password: '[Redacted]'"],
  ["apiKey=AKIA0000000000000000", "apiKey=[Redacted]"],
  ["secret=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD", "secret=[Redacted]"],
  ["AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD", "[Redacted]"],
  ["password=fixture-credential", "password=[Redacted]"],
  ["password=`fixture value`", "password=`[Redacted]`"],
  ["authorization: Bearer fixture-credential", "authorization: [Redacted]"],
  ['"tokens": 123', '"tokens": "[Redacted]"'],
  ["-----BEGIN PRIVATE KEY-----\nFAKE-KEY-FIXTURE\n-----END PRIVATE KEY-----", "[Redacted]"],
  ["-----BEGIN RSA PRIVATE KEY-----\nFAKE-INCOMPLETE-KEY", "[Redacted]"],
];

describe("command output redaction", () => {
  it.each(["otp", "totp", "authCode", "auth_code", "auth-code", "OTP", "TOTP", "AUTH_CODE"])(
    "hides numeric authentication codes under %s",
    (key) => {
      const value = "123456";
      for (const redact of [redactCommandOutput, redactSensitiveText, redactCredentialText]) {
        for (const input of [
          `${key}: ${value}`,
          `${key}=${value}`,
          JSON.stringify({ [key]: value }),
          JSON.stringify({ [key]: Number(value) }),
          ...["n", "r", "t"].map((escapeLetter) => `status=ready\\${escapeLetter}${key}: ${value}`),
        ]) {
          expect(redact(input)).toContain("[Redacted]");
          expect(redact(input)).not.toContain(value);
        }
      }
      for (const code of [value, Number(value)]) {
        expect(redactBindings({ [key]: code })).toEqual({ [key]: "[Redacted]" });
        expect(JSON.stringify(redactBindings({ [key]: code }))).not.toContain(value);
      }
    },
  );
  it.each(sourceLines)("preserves source: %s", (line) => {
    expect(redactCommandOutput(line)).toBe(line);
  });
  it.each(credentials)("hides credential values: %s", (line, expected) => {
    expect(redactCommandOutput(line!)).toBe(expected);
  });
  it.each(
    ["n", "r", "t"].flatMap((escapeLetter) => [
      [`password: my\\${escapeLetter}secret`, "password: [Redacted]"],
      [`password: my\\${escapeLetter}user:name`, "password: [Redacted]"],
      [`api_key=my\\${escapeLetter}foo=bar`, "api_key=[Redacted]"],
      [`Authorization: Bearer my\\${escapeLetter}secret`, "Authorization: [Redacted]"],
      [`password: hunter2\\${escapeLetter}`, "password: [Redacted]"],
    ]),
  )("fully masks secrets that contain literal shell escapes: %s", (line, expected) => {
    expect(redactCommandOutput(line!)).toBe(expected);
    expect(redactSensitiveText(line!)).toBe(expected);
    expect(redactCredentialText(line!)).toBe(expected);
    expect(redactBindings({ value: line }).value).toBe(expected);
  });
  it("preserves shell quotes around a fully masked authorization value", () => {
    expect(redactCommandOutput("curl -H 'Authorization: Bearer my\\nsecret'")).toBe(
      "curl -H 'Authorization: [Redacted]'",
    );
    expect(redactCommandOutput("api_key=a\\tb")).toBe("api_key=[Redacted]");
  });
  it("ends an unquoted secret value at a real newline", () => {
    expect(redactCommandOutput("password: hunter2\nmaxTokens: 4096")).toBe(
      "password: [Redacted]\nmaxTokens: 4096",
    );
  });
  it.each([
    ["password: hunter2,", "password: [Redacted],"],
    ["password: mysecretpassword\n", "password: [Redacted]\n"],
    ["secret=mysecret", "secret=[Redacted]"],
    ["token: shortToken;", "token: [Redacted];"],
    ["authKey: shortKey}", "authKey: [Redacted]}"],
    ["credential: shortCredential]", "credential: [Redacted]]"],
    ["PASSWORD=hunter2\r\n", "PASSWORD=[Redacted]\r\n"],
    ["cookie: sessionValue", "cookie: [Redacted]"],
    ["authorization: opaqueValue", "authorization: [Redacted]"],
    ["clientSecret: shortSecret,", "clientSecret: [Redacted],"],
  ])("hides ambiguous unquoted credentials: %s", (line, expected) => {
    expect(redactCommandOutput(line!)).toBe(expected);
  });
  it.each(sourceLines.filter((line) => /^\s*tokens?:/.test(line)))(
    "keeps shared log, memory and evidence text conservative: %s",
    (line) => {
      expect(redactSensitiveText(line)).toContain("[Redacted]");
      expect(redactCredentialText(line)).toContain("[Redacted]");
      expect(redactBindings({ value: line }).value).toContain("[Redacted]");
    },
  );

  it("masks only real secret values in shell text with escapes", () => {
    // The command card shows the command with literal \n sequences; the reply
    // shows the same text after printf turns them into real newlines.
    const command = "printf 'maxTokens: 4096\\nknownSecrets: secrets\\npassword: hunter2\\n'";
    expect(redactCommandOutput(command)).toBe(
      "printf 'maxTokens: 4096\\nknownSecrets: secrets\\npassword: [Redacted]'",
    );
    expect(redactCommandOutput("maxTokens: 4096\nknownSecrets: secrets\npassword: hunter2\n")).toBe(
      "maxTokens: 4096\nknownSecrets: secrets\npassword: [Redacted]\n",
    );
  });
  it.each([
    ["password: hunter2", "password: [Redacted]"],
    ["api_key=x9f2", "api_key=[Redacted]"],
    ["apiToken: x", "apiToken: [Redacted]"],
    ["accessToken=x", "accessToken=[Redacted]"],
    ["token: x", "token: [Redacted]"],
    ["Authorization: Bearer abc123", "Authorization: [Redacted]"],
    ["token: ghp_fixtureOnlyNotARealCredential1234567890", "token: [Redacted]"],
  ])("still masks real secret values: %s", (line, expected) => {
    expect(redactCommandOutput(line!)).toBe(expected);
  });
  it.each(["secret", "password", "apiKey"])("hides quoted %s source values", (key) => {
    expect(redactCommandOutput(`${key}: "ordinary source"`)).toBe(`${key}: "[Redacted]"`);
  });

  it.each([
    "password=123456",
    "password: 123456",
    "token=0xabcdef",
    "apiKey = 42",
    "otp: 004211",
    "GITHUB_PAT=987654",
  ])("masks a number under a credential key in command output: %s", (input) => {
    const value = input.split(/[:=]\s*/)[1]!;
    const result = redactCommandOutput(input);
    expect(result).toContain("[Redacted]");
    expect(result).not.toContain(value);
  });

  it.each(["maxTokens: 4096", "tokenCount = 12", "retries: 3", "sortKey = 2"])(
    "keeps numbers under named counters and ordinary keys readable: %s",
    (input) => {
      expect(redactCommandOutput(input)).toBe(input);
    },
  );
});
