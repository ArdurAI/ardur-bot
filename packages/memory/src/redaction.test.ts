import { describe, expect, it } from "vitest";
import { assertMemorySafe, MemoryRedactionError } from "./redaction.js";

// The shape MemoryService.commit checks: the body travels inside an object.
const commit = (content: string) => ({
  scope: "user",
  path: "skills/fixture.md",
  content,
  expectedRevision: 0,
});
const safe = (content: string) => () => assertMemorySafe(commit(content));

describe("memory credential gate", () => {
  it("does not read JSON escapes joined to the next word as credentials", () => {
    // A line break before a decorator encodes as "\n@app.post", which reads as an address.
    expect(safe('Routes:\n@app.post("/items")\ndef create():\n    pass\n')).not.toThrow();
    expect(safe("Fixtures:\n\n@pytest.fixture\ndef client():\n    return None\n")).not.toThrow();
    // An escaped quote after "Bearer " must not become the credential itself.
    expect(safe('req.Header.Set("Authorization", "Bearer "+token)')).not.toThrow();
    expect(safe('curl -H "X-Auth: Bearer [Redacted]" https://api.example.test')).not.toThrow();
  });

  it("lets placeholder values in JSON examples through", () => {
    for (const value of [
      "",
      "[Redacted]",
      "...",
      "***",
      "<your password>",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder in an example.
      "${TOKEN}",
      "{{token}}",
    ])
      expect(safe(`{\n  "email": "${value}",\n  "password": "${value}"\n}`)).not.toThrow();
  });

  it("still refuses real-looking credentials", () => {
    const github = ["gh", "p_", "a1B2".repeat(9)].join("");
    const aws = ["AKIA", "Q3EXAMPLEKEY7ABC"].join("");
    for (const content of [
      "Write to alice@corp.example.test when it breaks.",
      "Authorization: Bearer abc123def456ghi789",
      "password = correct-horse-battery",
      '{"password": "correct-horse-battery"}',
      '{"api_key": "live-value-9f8e7d6c"}',
      `Deploy key ${github} here.`,
      `-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----`,
      "postgres://admin:hunter22@db.example.test/app",
      // Line starts: JSON encoding once hid these behind "\n".
      "Keys:\nsk-live-0123456789abcdef",
      `Keys:\n${aws}`,
    ])
      expect(safe(content), content).toThrow(MemoryRedactionError);
    expect(() => assertMemorySafe({ note: "fine", token: "abc123" })).toThrow(MemoryRedactionError);
    expect(() => assertMemorySafe(commit('run "private-value"'), ["private-value"])).toThrow(
      MemoryRedactionError,
    );
    // A known secret with a quote or line break is found in the text as written.
    expect(() => assertMemorySafe(commit('use a"b\nc now'), ['a"b\nc'])).toThrow(
      MemoryRedactionError,
    );
  });
});
