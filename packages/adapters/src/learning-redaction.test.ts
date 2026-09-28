import { containsSecret } from "@ardurbot/core";
import { expect, it, vi } from "vitest";
import { assertSafeMemoryContent } from "./learning-memory-safety.js";
import { learningSecrets } from "./learning-redaction.js";

it("collects stored credential formats without connection metadata", async () => {
  const stored = [
    {
      kind: "model",
      value: JSON.stringify({
        type: "oauth",
        access: "ab12cd",
        refresh: "opaque-refresh-42",
        expires: 999,
      }),
    },
    {
      kind: "model",
      value: JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "https://repo.example.test",
        apiKey: "key-987",
      }),
    },
    {
      kind: "mcp",
      value: JSON.stringify({
        label: "repo",
        name: "code",
        description: "project",
        mode: "plain",
        args: ["--token", "argument-456", "/tmp"],
        secret: "mcp-secret",
        env: { PGPASSWORD: "bluebird-42", LOG_LEVEL: "info" },
        headers: { "X-Auth": "header-789", "X-Mode": "plain" },
        credentialFlags: {
          env: { PGPASSWORD: true, LOG_LEVEL: false },
          headers: { "X-Auth": true, "X-Mode": false },
        },
        oauth: { tokens: { access_token: "access-123", refresh_token: "refresh-123" } },
      }),
    },
    {
      kind: "other",
      value: JSON.stringify({ credential: { value: "other-123", name: "repo" }, label: "plain" }),
    },
    {
      kind: "memory-provider",
      value: JSON.stringify({ ARBITRARY: "provider-456", label: "memory-789" }),
    },
    {
      kind: "memory-git",
      value: JSON.stringify({
        kind: "token",
        value: "git-123",
        repositoryUrl: "https://project.example.test",
      }),
    },
    { kind: "computer", value: JSON.stringify({ inline: "config-123", path: "plain" }) },
    { kind: "agent-environment", value: '{"opaque":"host-123"}' },
  ];
  const prisma = {
    secret: {
      findMany: vi.fn(async () =>
        stored.map((item, index) => ({
          id: String(index),
          kind: item.kind,
          ciphertext: "fixture",
        })),
      ),
    },
    botSecret: { findMany: vi.fn(async () => [{ id: "bot-secret", ciphertext: "fixture" }]) },
  };
  const store = {
    load: vi.fn((_ciphertext: string, id: string) =>
      id === "bot-secret" ? "bot123" : stored[Number(id)]!.value,
    ),
  };
  const collected = await learningSecrets(prisma as never, store as never, {
    spaceId: "space",
    userId: "user",
    botId: "bot",
  });
  expect(collected).toEqual([
    "ab12cd",
    "opaque-refresh-42",
    "key-987",
    "argument-456",
    "mcp-secret",
    "access-123",
    "refresh-123",
    "header-789",
    "bluebird-42",
    "other-123",
    "provider-456",
    "memory-789",
    "git-123",
    "config-123",
    '{"opaque":"host-123"}',
    "bot123",
  ]);
  for (const metadata of [
    "repo",
    "code",
    "project",
    "plain",
    "https://repo.example.test",
    "oauth",
    "999",
    "info",
    "/tmp",
  ])
    expect(collected).not.toContain(metadata);
  expect(containsSecret("Include useful information.", collected)).toBe(false);
  expect(() => assertSafeMemoryContent("information", collected)).not.toThrow();
  for (const value of ["bluebird-42", "header-789"]) {
    try {
      assertSafeMemoryContent(`Remember ${value} in this note.`, collected);
      throw new Error("Expected the import to be rejected");
    } catch (error) {
      expect(error).toMatchObject({
        lineNumber: 1,
        maskedLine: "Remember [redacted] in this note.",
      });
    }
  }
});
