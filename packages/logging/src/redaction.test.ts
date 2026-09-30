import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { redactBindings, redactSensitiveText } from "./redaction.js";

describe("redaction", () => {
  it.each([
    ["review filler", () => "x".repeat(1024 * 1024)],
    ["email local part", () => "a.".repeat(512 * 1024)],
    ["unterminated quoted value", () => `password="${"token='".repeat(150000)}`],
    ["quoted key", () => `"${"password ".repeat(120000)}"`],
    ["URL colons", () => `https://fixture:${":".repeat(1024 * 1024)}`],
    ["JWT prefixes", () => "eyJ-".repeat(256 * 1024)],
    ["key prefixes", () => "sk-".repeat(350000)],
  ])("redacts a 1 MiB adversarial line in under 50 ms: %s", (_name, input) => {
    // Compile the matchers before measuring; construction and assertions are not timed.
    redactSensitiveText("Safe diagnostic");
    const line = `${input()} token=fixture-credential`;
    const start = performance.now();
    const redacted = redactSensitiveText(line);
    const elapsed = performance.now() - start;
    expect(redacted).not.toContain("fixture-credential");
    expect(elapsed).toBeLessThan(50);
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
