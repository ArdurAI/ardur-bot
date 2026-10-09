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
  it.each(sourceLines)("preserves source: %s", (line) => {
    expect(redactCommandOutput(line)).toBe(line);
  });
  it.each(credentials)("hides credential values: %s", (line, expected) => {
    expect(redactCommandOutput(line!)).toBe(expected);
  });
  it("fully masks secrets that contain literal shell escapes", () => {
    expect(redactCommandOutput("password: my\\nsecret")).toBe("password: [Redacted]");
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
    ["knownSecrets: shortSecret,", "knownSecrets: [Redacted],"],
  ])("hides ambiguous unquoted credentials: %s", (line, expected) => {
    expect(redactCommandOutput(line!)).toBe(expected);
  });
  it.each(sourceLines.filter((line) => line.includes(":")))(
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
      "printf 'maxTokens: 4096\\nknownSecrets: secrets\\npassword: [Redacted]\\n'",
    );
    expect(redactCommandOutput("maxTokens: 4096\nknownSecrets: secrets\npassword: hunter2\n")).toBe(
      "maxTokens: 4096\nknownSecrets: secrets\npassword: [Redacted]\n",
    );
  });
  it.each([
    ["password: hunter2", "password: [Redacted]"],
    ["api_key=x9f2", "api_key=[Redacted]"],
    ["Authorization: Bearer abc123", "Authorization: [Redacted]"],
    ["token: ghp_fixtureOnlyNotARealCredential1234567890", "token: [Redacted]"],
  ])("still masks real secret values: %s", (line, expected) => {
    expect(redactCommandOutput(line!)).toBe(expected);
  });
  it.each(["secret", "password", "apiKey"])("hides quoted %s source values", (key) => {
    expect(redactCommandOutput(`${key}: "ordinary source"`)).toBe(`${key}: "[Redacted]"`);
  });
});
