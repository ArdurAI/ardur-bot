import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  redactBindings,
  redactCommandOutput,
  redactCredentialText,
  redactSensitiveText,
} from "./redaction.js";

describe("redaction", () => {
  it.each([
    "apiTokens",
    "mySecrets",
    "authCredentials",
    "accessTokens",
    "clientSecrets",
    "api_tokens",
    "secretValue",
    "tokenData",
    "credentialBundle",
    "unknownSecrets",
    "maxTokensSecret",
    "inputToken",
    "outputToken",
    "cachedToken",
    "contextToken",
    "promptToken",
    "passphrase",
    "pass_phrase",
    "pass-phrase",
    "PASSPHRASE",
    ...["signing", "encryption", "master", "app", "ssh"].flatMap((prefix) => [
      `${prefix}Key`,
      `${prefix}_key`,
      `${prefix}-key`,
      `${prefix.toUpperCase()}_KEY`,
    ]),
    "authCode",
    "auth_code",
    "auth-code",
    "AUTH_CODE",
    "otp",
    "OTP",
    "totp",
    "TOTP",
    "github_pat",
    "github-pat",
    "githubPat",
    "GITHUB_PAT",
    "gitlab_pat",
    "gitlab-pat",
    "gitlabPat",
    "GITHUBPat",
    "APIPat",
    "GITLAB_PAT",
  ])("masks credential key families: %s", (key) => {
    const secretValue = "fixture-private-value";
    const data = { [key]: secretValue };
    const bindings = redactBindings(data);
    expect(bindings).toEqual({ [key]: "[Redacted]" });
    expect(JSON.stringify(bindings)).not.toContain(secretValue);
    for (const redact of [redactSensitiveText, redactCommandOutput, redactCredentialText]) {
      for (const text of [
        `${key}: ${secretValue}`,
        `${key}=${secretValue}`,
        JSON.stringify(data),
        ...["n", "r", "t"].map(
          (escapeLetter) => `status=ready\\${escapeLetter}${key}: ${secretValue}`,
        ),
      ]) {
        const result = redact(text);
        expect(result).toContain("[Redacted]");
        expect(result).not.toContain(secretValue);
      }
    }
  });

  it.each([
    // A singular token key is a counter only after a limit word; "cachedToken" can hold one.
    ...["max", "min", "num", "total"].map((prefix) => `${prefix}Token`),
    ...[
      "max",
      "min",
      "num",
      "total",
      "used",
      "remaining",
      "input",
      "output",
      "prompt",
      "completion",
      "cached",
      "reasoning",
      "context",
    ].flatMap((prefix) => [`${prefix}Tokens`, `${prefix}_tokens`]),
    "tokenCount",
    "tokensUsed",
    "knownSecrets",
    "requiredSecrets",
    "missingSecrets",
    "secretNames",
    "secretRef",
    "secretId",
    "secretStore",
    "parentSecretAbsent",
    "apiTokenPresent",
    "credentialId",
    "modelCredentialId",
  ])("preserves explicitly named credential metadata: %s", (key) => {
    const data = { [key]: "fixture-reference" };
    expect(redactBindings(data)).toEqual(data);
    for (const redact of [redactSensitiveText, redactCommandOutput, redactCredentialText]) {
      for (const text of [
        `${key}: fixture-reference`,
        `${key}=fixture-reference`,
        JSON.stringify(data),
      ]) {
        expect(redact(text)).toBe(text);
      }
    }
  });

  it.each([
    "sortKey",
    "sort_key",
    "sort-key",
    "primaryKey",
    "primary_key",
    "primary-key",
    "keyId",
    "key_id",
    "key-id",
    "cacheKey",
    "cache_key",
    "cache-key",
    "pinned",
    "pin",
    // PIN-like names are ambiguous application data; only explicit OTP names are added.
    "pinCode",
    "pin_code",
    "pin-code",
    "keyboard",
    "monkey",
    "hotplug",
    "adoption",
    "authCodec",
    "compat",
    "COMPAT",
    "COMPATIBLE",
    "format",
    "pattern",
    "dispatch",
    "patCount",
    "githubPattern",
  ])("preserves nearby non-credential names: %s", (key) => {
    const value = "fixture-public-value";
    const data = { [key]: value };
    expect(redactBindings(data)).toEqual(data);
    for (const redact of [redactSensitiveText, redactCommandOutput, redactCredentialText]) {
      for (const text of [`${key}: ${value}`, `${key}=${value}`, JSON.stringify(data)]) {
        expect(redact(text)).toBe(text);
      }
    }
  });

  it.each(
    ["n", "t", "r"].flatMap((escapeLetter) =>
      [":", "="].flatMap((separator) => [
        `printf 'apiToken${separator} x\\${escapeLetter}password${separator} y\\${escapeLetter}'`,
        `export TOKEN=x\\\\${escapeLetter}password${separator} y`,
        `apiToken${separator} fixture-first\\${escapeLetter}password${separator}\tfixture-second\\${escapeLetter}clientSecret${separator} fixture-third`,
        `"apiToken"${separator} fixture-first\\${escapeLetter}password${separator} fixture-second`,
        `apiToken${separator} fixture-first\\${escapeLetter}"password"${separator} fixture-second`,
        `apiToken${separator} fixture-first\\${escapeLetter}'password'${separator} fixture-second`,
        `apiToken${separator} fixture-first\\${escapeLetter}password${separator} "fixture-second value"`,
        `apiToken${separator} fixture-first\\${escapeLetter}password${separator} {"safe":"fixture-second"}`,
        `apiToken${separator} fixture-first\\${escapeLetter}Authorization${separator} Basic fixture-second`,
      ]),
    ),
  )("masks every value in escaped sensitive assignment chains: %s", (input) => {
    for (const redact of [redactSensitiveText, redactCommandOutput, redactCredentialText]) {
      const result = redact(input);
      expect(result).toContain("[Redacted]");
      for (const secretValue of ["x", "y", "fixture-first", "fixture-second", "fixture-third"]) {
        // The command word itself contains x; inspect its retained arguments.
        expect(result.replace(/^export /, "")).not.toContain(secretValue);
      }
      expect(redact(result)).toBe(result);
    }
    const bindings = redactBindings({ detail: input });
    for (const secretValue of ["x", "y", "fixture-first", "fixture-second", "fixture-third"]) {
      expect(String(bindings.detail).replace(/^export /, "")).not.toContain(secretValue);
    }
  });

  it.each([
    String.raw`printf 'apiToken: fixture-first\token: fixture-second\n'`,
    String.raw`printf 'note\token: fixture-first'`,
    "apiToken: fixture-first|password: fixture-second",
    "apiToken: fixture-first/password: fixture-second",
    "apiToken: password: fixture-second",
    "password: fixture-first token: fixture-second",
    "inputToken: fixture-first outputToken: fixture-second",
  ])("masks a sensitive key glued to a masked value and its value: %s", (input) => {
    for (const redact of [redactSensitiveText, redactCommandOutput, redactCredentialText]) {
      const result = redact(input);
      expect(result).toContain("[Redacted]");
      expect(result).not.toContain("fixture-first");
      expect(result).not.toContain("fixture-second");
    }
  });

  it.each(["model", "maxTokens", "knownSecrets"])(
    "keeps the value of a non-sensitive escaped assignment: %s",
    (key) => {
      const input = `apiToken: fixture-private-value\\n${key}: fixture-public-value`;
      for (const redact of [redactSensitiveText, redactCommandOutput, redactCredentialText]) {
        const result = redact(input);
        expect(result).not.toContain("fixture-private-value");
        expect(result).toContain("fixture-public-value");
      }
    },
  );

  it.each([
    "maxTokens: 4096",
    "max_tokens=4096",
    "MAX_TOKENS=4096",
    "tokenCount=12",
    "knownSecrets: secrets",
    "known_secrets=secrets",
    "secretStore: store",
  ])("preserves non-credential key assignments: %s", (input) => {
    expect(redactSensitiveText(input)).toBe(input);
  });

  it("uses the same credential classification for bindings and JSON text", () => {
    const input = {
      maxTokens: 4096,
      tokenCount: 12,
      knownSecrets: "secrets",
      apiToken: "x",
      accessToken: "x",
      token: "x",
      api_token: "x",
      ACCESS_TOKEN: "x",
      clientSecret: "x",
      client_secret: "x",
      tokens: ["x"],
      secrets: ["x"],
      credentials: ["x"],
    };
    const expected = {
      ...input,
      apiToken: "[Redacted]",
      accessToken: "[Redacted]",
      token: "[Redacted]",
      api_token: "[Redacted]",
      ACCESS_TOKEN: "[Redacted]",
      clientSecret: "[Redacted]",
      client_secret: "[Redacted]",
      tokens: "[Redacted]",
      secrets: "[Redacted]",
      credentials: "[Redacted]",
    };
    expect(redactBindings(input)).toEqual(expected);
    expect(JSON.parse(redactSensitiveText(JSON.stringify(input)))).toEqual(expected);
  });

  it.each([
    ["review filler", () => "x".repeat(1024 * 1024)],
    ["email local part", () => "a.".repeat(512 * 1024)],
    ["unterminated quoted value", () => `password="${"token='".repeat(150000)}`],
    ["quoted key", () => `"${"password ".repeat(120000)}"`],
    ["URL colons", () => `https://fixture:${":".repeat(1024 * 1024)}`],
    ["JWT prefixes", () => "eyJ-".repeat(256 * 1024)],
    ["key prefixes", () => "sk-".repeat(350000)],
    ["masked value ending in a separator", () => `apiToken: ${"a".repeat(1024 * 1024)}|:`],
  ])("redacts a 1 MiB adversarial line without catastrophic backtracking: %s", (_name, input) => {
    // Compile the matchers before measuring; construction and assertions are not timed.
    redactSensitiveText("Safe diagnostic");
    const line = `${input()} token=fixture-credential`;
    const start = performance.now();
    const redacted = redactSensitiveText(line);
    const elapsed = performance.now() - start;
    expect(redacted).not.toContain("fixture-credential");
    // A linear pass over 1 MiB takes a few tens of milliseconds; catastrophic backtracking takes
    // seconds to minutes. The bound only needs to separate the two, so it leaves room for a busy
    // CI runner (a 50 ms bound failed at 55 ms on shared hardware).
    expect(elapsed).toBeLessThan(500);
  });

  it.each([
    ["cookie='alpha \\'beta\\' gamma'", "cookie='[Redacted]'"],
    ['API_KEY="alpha \\"beta\\" gamma"', 'API_KEY="[Redacted]"'],
    ['{"password hint": "alpha beta gamma"}', '{"password hint": "[Redacted]"}'],
    ["token:fixture-value", "token:[Redacted]"],
    ['secret="unterminated token=fixture', 'secret="[Redacted]'],
    ["https://fixture:alpha:beta@gateway.example", "https://[Redacted]@gateway.example"],
    ["prefix-eyJfixture.payload.signature", "[Redacted]"],
    ["ordinary.version.string", "ordinary.version.string"],
  ])("preserves redaction semantics for %s", (input, expected) => {
    expect(redactSensitiveText(input)).toBe(expected);
  });

  it("preserves non-secret metadata without exempting sensitive non-string values", () => {
    const data = {
      parentSecretAbsent: true,
      configHasKey: false,
      tokenCount: 42,
      credential: null,
      tokens: [],
      secrets: { password: "fixture-credential" },
    };
    expect(JSON.parse(redactSensitiveText(JSON.stringify(data)))).toEqual({
      ...data,
      credential: "[Redacted]",
      tokens: "[Redacted]",
      secrets: "[Redacted]",
    });
  });

  it("preserves setting keys, scope keys and credential references", () => {
    const data = {
      key: "bot.autoSpeak",
      value: true,
      scopeKey: { kind: "bot", botId: "fixture" },
      credentialId: "fixture-connection",
      key_env: "FIXTURE_PROVIDER_KEY",
    };
    const text = JSON.stringify(data);
    expect(redactSensitiveText(text)).toBe(text);
  });

  it.each(
    [
      "Bearer",
      "bEaReR",
      "Basic",
      "bAsIc",
      "Token",
      "tOkEn",
      "FixtureScheme",
      "fIxTuReScHeMe",
      "Fixture.Scheme",
      "fixture+scheme",
    ].flatMap((scheme) => [
      [
        `${scheme} header`,
        `AuThOrIzAtIoN: ${scheme} fixture-credential\r\nstatus=ready`,
        "AuThOrIzAtIoN: [Redacted]\r\nstatus=ready",
      ],
      [
        `${scheme} JSON`,
        JSON.stringify({ aUtHoRiZaTiOn: `${scheme} fixture-credential`, status: "ready" }),
        '{"aUtHoRiZaTiOn":"[Redacted]","status":"ready"}',
      ],
      [
        `${scheme} query`,
        `?aUtHoRiZaTiOn=${scheme} fixture-credential&status=ready`,
        "?aUtHoRiZaTiOn=[Redacted]&status=ready",
      ],
      [
        `${scheme} env`,
        `AUTHORIZATION=${scheme} fixture-credential status=ready`,
        "AUTHORIZATION=[Redacted] status=ready",
      ],
      [
        `${scheme} quoted env`,
        `AuThOrIzAtIoN="${scheme} fixture-credential" status=ready`,
        'AuThOrIzAtIoN="[Redacted]" status=ready',
      ],
    ]),
  )("redacts the complete auth value in %s", (_name, input, expected) => {
    const redacted = redactSensitiveText(input!);
    expect(redacted).toBe(expected);
    expect(redactSensitiveText(redacted)).toBe(redacted);
  });

  it.each([
    "?authorization=Basic%20fixture-credential&status=ready",
    "?AUTHORIZATION=FixtureScheme+fixture-credential&status=ready",
    "Proxy-Authorization: FixtureScheme\tfixture-credential\r\nstatus=ready",
  ])("redacts encoded or tab-separated auth values: %s", (input) => {
    const redacted = redactSensitiveText(input);
    expect(redacted).not.toContain("fixture-credential");
    expect(redacted).toContain("status=ready");
  });

  it.each([
    ['Authorization: Basic "fixture credential"', "Authorization: [Redacted]"],
    ["AUTHORIZATION=FixtureScheme 'fixture credential'", "AUTHORIZATION=[Redacted]"],
    ['"Authorization: Bearer fixture-credential"', '"Authorization: [Redacted]"'],
  ])(
    "redacts quoted auth credentials while preserving surrounding quotes: %s",
    (input, expected) => {
      expect(redactSensitiveText(input)).toBe(expected);
    },
  );

  it.each([
    "PASSWORD",
    "Secret",
    "accessToken",
    "Api_Key",
    "CREDENTIAL",
    "Authorization",
    "Cookie",
  ])("redacts every JSON value type under %s", (key) => {
    for (const value of [
      123456,
      -123.456,
      true,
      false,
      null,
      [],
      [123456, { safe: 'fixture } ] \\" value' }],
      {},
      { safe: [123456, { nested: "fixture-value" }] },
    ]) {
      const data = { [key]: value, status: "ready" };
      expect(JSON.parse(redactSensitiveText(JSON.stringify(data)))).toEqual({
        [key]: "[Redacted]",
        status: "ready",
      });
      expect(redactBindings(data)).toEqual({ [key]: "[Redacted]", status: "ready" });
    }
  });

  it("preserves SHA-1 provenance while redacting AWS key shapes and explicit secrets", () => {
    const commitId = "0123456789abcdef".repeat(3).slice(0, 40);
    const secret = "Q7x9Z2v4B6n8D0p3".repeat(3).slice(0, 40);
    expect(redactSensitiveText(JSON.stringify({ commitId }))).toBe(JSON.stringify({ commitId }));
    expect(redactSensitiveText(`commit ${commitId}`)).toBe(`commit ${commitId}`);
    expect(redactSensitiveText(`AWS_SECRET_ACCESS_KEY=${commitId}`)).toBe(
      "AWS_SECRET_ACCESS_KEY=[Redacted]",
    );
    expect(redactSensitiveText(`key=${commitId}`)).toBe("key=[Redacted]");
    expect(redactSensitiveText(`credentials ${secret} ${secret}=`)).toBe(
      "credentials [Redacted] [Redacted]",
    );
  });

  it.each([
    "PASSWORD",
    "Secret",
    "accessToken",
    "Api_Key",
    "CREDENTIAL",
    "Authorization",
    "Cookie",
  ])("redacts a whole quoted %s value, including escaped quotes", (key) => {
    const raw = JSON.stringify({ [key]: 'alpha "beta" gamma' });
    const result = redactSensitiveText(raw);
    expect(result).not.toMatch(/alpha|beta|gamma/);
    expect(JSON.parse(result)).toEqual({ [key]: "[Redacted]" });
  });
  it("redacts secrets, credentials, and message bodies", () => {
    const redacted = redactBindings({
      "user.id": "user-1",
      email: "person@example.com",
      authorization: "Bearer secret",
      cookie: "session=abc",
      prompt: "do not log",
      messages: [{ role: "user", content: "hi" }],
      body: { text: "payload" },
      query: { q: "search" },
      apiKey: "sk-live",
      nested: { password: "hunter2", token: "abc", safe: true },
    });
    expect(redacted["user.id"]).toBe("user-1");
    expect(redacted.email).toBe("[Redacted]");
    expect(redacted.authorization).toBe("[Redacted]");
    expect(redacted.cookie).toBe("[Redacted]");
    expect(redacted.prompt).toBe("[Redacted]");
    expect(redacted.messages).toBe("[Redacted]");
    expect(redacted.body).toBe("[Redacted]");
    expect(redacted.query).toBe("[Redacted]");
    expect(redacted.apiKey).toBe("[Redacted]");
    expect(redacted.nested).toEqual({ password: "[Redacted]", token: "[Redacted]", safe: true });
  });

  it("replaces circular values", () => {
    const cycle: Record<string, unknown> = { "request.id": "r1" };
    cycle.self = cycle;
    const redacted = redactBindings(cycle);
    expect(redacted["request.id"]).toBe("r1");
    expect(redacted.self).toBe("[Circular]");
  });

  it("redacts Error values nested in bindings", () => {
    const cause = new Error("password=inner-secret");
    const error = new Error("request failed with token=outer-secret", { cause });

    const redacted = redactBindings({ detail: error });

    expect(redacted.detail).toMatchObject({
      name: "Error",
      message: "request failed with token=[Redacted]",
      cause: { name: "Error", message: "password=[Redacted]" },
    });
    expect(JSON.stringify(redacted.detail)).not.toMatch(/inner-secret|outer-secret/);
  });

  it("redacts custom Error names nested in bindings", () => {
    const secret = `xai-${"synthetic".repeat(3)}`;
    const error = new Error("Safe failure");
    error.name = secret;
    const redacted = redactBindings({ detail: error });
    expect(redacted.detail).toMatchObject({ name: "[Redacted]", message: "Safe failure" });
    expect(JSON.stringify(redacted)).not.toContain(secret);
  });

  it("redacts string Error causes", () => {
    const error = new Error("request failed", { cause: "token=cause-secret" });

    const redacted = redactBindings({ detail: error });

    expect(redacted.detail).toMatchObject({
      name: "Error",
      message: "request failed",
      cause: "token=[Redacted]",
    });
    expect(JSON.stringify(redacted.detail)).not.toContain("cause-secret");
  });

  it("redacts secrets embedded in string binding values", () => {
    const redacted = redactBindings({
      detail: "token=binding-secret",
      nested: { note: "Bearer nested-secret" },
    });

    expect(redacted).toEqual({
      detail: "token=[Redacted]",
      nested: { note: "Bearer [Redacted]" },
    });
  });

  it("redacts secrets embedded in free text", () => {
    const redacted = redactSensitiveText(
      "user person@example.com used Bearer supersecret and token=abc123",
    );
    expect(redacted).toContain("[Redacted]");
    expect(redacted).not.toContain("person@example.com");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).not.toContain("abc123");
  });

  it("redacts bare API keys and JWTs in free text", () => {
    const redacted = redactSensitiveText(
      "key sk-or-v1-abc123456789 and sk-live-secret99 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig ak_secretvaluehere",
    );
    expect(redacted).not.toMatch(
      /sk-or-v1-abc123456789|sk-live-secret99|eyJhbGciOiJIUzI1NiJ9|ak_secretvaluehere/,
    );
    expect(redacted).toContain("[Redacted]");
  });

  it("redacts quoted JSON credential fields", () => {
    const redacted = redactSensitiveText(
      '{"password":"hunter2","token":"abc","authorization":"Bearer secret"}',
    );
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain('"token":"abc"');
    expect(redacted).not.toContain("Bearer secret");
    expect(redacted).toContain('"password":"[Redacted]"');
    expect(redacted).toContain('"token":"[Redacted]"');
    expect(redacted).toContain('"authorization":"[Redacted]"');
  });

  it("leaves placeholder JSON credential values unchanged", () => {
    const example =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder in an example.
      '{"email": "[Redacted]", "password": "", "token": "...", "apiKey": "<key>", "secret": "${SECRET}"}';
    expect(redactSensitiveText(example)).toBe(example);
    expect(redactSensitiveText('{"email": "[Redacted]", "token": "abc"}')).toBe(
      '{"email": "[Redacted]", "token": "[Redacted]"}',
    );
  });
});
