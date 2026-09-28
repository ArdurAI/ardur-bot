import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRuntimeConfigText } from "./runtime-config-editor.js";

const fixtures = JSON.parse(
  readFileSync(new URL("./runtime-config-fixtures.json", import.meta.url), "utf8"),
) as {
  valid: string[];
  invalid: string[];
};

describe("bounded Advanced JSON input", () => {
  it("agrees with the portable acceptance corpus", () => {
    for (const text of fixtures.valid)
      expect(parseRuntimeConfigText(text).success, text).toBe(true);
    for (const text of fixtures.invalid)
      expect(parseRuntimeConfigText(text).success, text).toBe(false);
  });

  it("rejects size, depth, member count, malformed and non-finite numbers", () => {
    expect(parseRuntimeConfigText(" ".repeat(16_385)).issues[0]?.code).toBe("document-too-large");
    expect(
      parseRuntimeConfigText(
        `{"version":2,"runtimeKind":"hermes","x":${"[".repeat(10)}0${"]".repeat(10)}}`,
      ).issues[0]?.code,
    ).toBe("too-deep");
    const many = Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [`key${index}`, index]),
    );
    expect(
      parseRuntimeConfigText(JSON.stringify({ version: 2, runtimeKind: "hermes", ...many }))
        .issues[0]?.code,
    ).toBe("too-many-members");
    for (const text of [
      "{",
      "{} trailing",
      '{"version":2,}',
      '{"version":1e999,"runtimeKind":"hermes"}',
    ])
      expect(parseRuntimeConfigText(text).success).toBe(false);
  });

  it("classifies forbidden fields without echoing values or unknown keys", () => {
    const marker = "fake-secret-marker";
    for (const field of [
      "model",
      "provider",
      "fallback_providers",
      "model_overrides",
      "headers",
      "base_url",
      "mcp_servers",
      "toolsets",
      "skills",
      "plugins",
      "hooks",
      "approvals",
      "env",
      "workspace",
      "network",
      "proxy",
      "packages",
      "allow_lazy_installs",
      "memory",
      "background_review",
      "delegation",
      "compression",
      "compaction",
      marker,
    ]) {
      const result = parseRuntimeConfigText(
        JSON.stringify({ version: 2, runtimeKind: "hermes", [field]: marker }),
      );
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.issues)).not.toContain(marker);
    }
    expect(
      parseRuntimeConfigText(
        '{"version":2,"runtimeKind":"hermes","harness":{"agent":{"compression":true}}}',
      ).issues[0]?.code,
    ).toBe("native-compression-unavailable");
  });

  it("rejects coercion, fractional values and unknown nested fields", () => {
    for (const value of ["unlimited", "0", true, null, 1.5, 65, -1]) {
      const text = JSON.stringify({
        version: 2,
        runtimeKind: "hermes",
        limits: { maxProviderRequests: value },
      });
      expect(parseRuntimeConfigText(text).success, text).toBe(false);
    }
    expect(
      parseRuntimeConfigText(
        '{"version":2,"runtimeKind":"hermes","limits":{"api_key":"fake-secret-marker"}}',
      ).issues[0]?.code,
    ).toBe("managed-connection");
    expect(
      parseRuntimeConfigText(
        '{"version":2,"runtimeKind":"hermes","harness":{"agent":{"api_max_retries":4}}}',
      ).issues[0]?.code,
    ).toBe("out-of-range");
  });
});
