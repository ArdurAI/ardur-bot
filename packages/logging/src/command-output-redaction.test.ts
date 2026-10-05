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
  it.each(sourceLines.filter((line) => line.includes(":")))(
    "keeps shared log, memory and evidence text conservative: %s",
    (line) => {
      expect(redactSensitiveText(line)).toContain("[Redacted]");
      expect(redactCredentialText(line)).toContain("[Redacted]");
      expect(redactBindings({ value: line }).value).toContain("[Redacted]");
    },
  );
  it.each(["secret", "password", "apiKey"])("hides quoted %s source values", (key) => {
    expect(redactCommandOutput(`${key}: "ordinary source"`)).toBe(`${key}: "[Redacted]"`);
  });
});
