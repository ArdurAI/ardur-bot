// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Bundle fixtures contain literal protocol placeholders.
import { describe, expect, it } from "vitest";
import {
  configurationFields,
  parseMcpbManifest,
  resolveMcpbLaunch,
  validateUserConfig,
} from "./manifest.js";

function manifestFixture() {
  return {
    manifest_version: "0.3",
    name: "fixture-extension",
    version: "1.0.0",
    description: "A fixture server",
    author: { name: "Fixture publisher" },
    server: {
      type: "node",
      entry_point: "server/index.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/index.js", "${user_config.directories}"],
        env: { API_TOKEN: "${user_config.token}", VERBOSE: "${user_config.verbose}" },
        platform_overrides: { win32: { command: "node.exe", env: { PLATFORM: "windows" } } },
      },
    },
    compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=22" } },
    tools: [{ name: "read_fixture", description: "Read a fixture" }],
    user_config: {
      token: {
        type: "string",
        title: "Token",
        description: "Authentication",
        sensitive: true,
        required: true,
      },
      directories: {
        type: "directory",
        title: "Folders",
        description: "Allowed folders",
        multiple: true,
        required: true,
      },
      verbose: {
        type: "boolean",
        title: "Verbose",
        description: "Verbose logging",
        default: false,
      },
      limit: {
        type: "number",
        title: "Limit",
        description: "Result limit",
        default: 5,
        min: 1,
        max: 10,
      },
    },
  };
}

describe("MCPB and legacy DXT manifests", () => {
  it.each(["0.1", "0.2", "0.3", "0.4"])(
    "accepts version %s under either official version key",
    (version) => {
      const fixture = manifestFixture();
      expect(
        parseMcpbManifest({ ...fixture, manifest_version: version }, "linux").manifest_version,
      ).toBe(version);
      const { manifest_version: _, ...legacy } = fixture;
      expect(parseMcpbManifest({ ...legacy, dxt_version: version }, "linux").manifest_version).toBe(
        version,
      );
    },
  );
  it.each(["name", "version", "description", "author", "server", "manifest_version"])(
    "rejects a missing %s",
    (field) => {
      const fixture: Record<string, unknown> = manifestFixture();
      delete fixture[field];
      expect(() => parseMcpbManifest(fixture)).toThrow();
    },
  );
  it("rejects conflicting versions, unsupported platforms, traversal and malformed launch arguments", () => {
    expect(() => parseMcpbManifest({ ...manifestFixture(), dxt_version: "0.1" })).toThrow();
    expect(() =>
      parseMcpbManifest({ ...manifestFixture(), compatibility: { platforms: ["win32"] } }, "linux"),
    ).toThrow("does not support");
    const fixture = manifestFixture();
    fixture.server.entry_point = "../escape.js";
    expect(() => parseMcpbManifest(fixture)).toThrow("unsafe file path");
    expect(() =>
      parseMcpbManifest({
        ...manifestFixture(),
        server: { ...manifestFixture().server, mcp_config: { command: "node", args: "--flag" } },
      }),
    ).toThrow();
    expect(() =>
      parseMcpbManifest({ ...manifestFixture(), user_config: JSON.parse('{"__proto__":{}}') }),
    ).toThrow("unsafe key");
  });
  it("validates required fields, primitive types, numeric ranges and unknown input", () => {
    const manifest = parseMcpbManifest(manifestFixture());
    expect(() => validateUserConfig(manifest, {})).toThrow("required");
    const base = { token: "fixture-token", directories: ["/fixtures"] };
    expect(validateUserConfig(manifest, base)).toEqual({ ...base, verbose: false, limit: 5 });
    expect(() => validateUserConfig(manifest, { ...base, limit: 11 })).toThrow("range");
    expect(() => validateUserConfig(manifest, { ...base, verbose: "false" })).toThrow("boolean");
    expect(() => validateUserConfig(manifest, { ...base, extra: "ignored" })).toThrow("unknown");
  });
  it("generates typed form fields without returning sensitive values or defaults", () => {
    const manifest = parseMcpbManifest(manifestFixture());
    manifest.user_config.token!.default = "fixture-default";
    const fields = configurationFields(manifest, { token: "fixture-secret" });
    expect(fields.find((field) => field.key === "token")).toMatchObject({
      sensitive: true,
      configured: true,
      type: "string",
    });
    expect(JSON.stringify(fields)).not.toContain("fixture-secret");
    expect(JSON.stringify(fields)).not.toContain("fixture-default");
    expect(fields.find((field) => field.key === "limit")).toMatchObject({
      value: 5,
      min: 1,
      max: 10,
    });
  });
  it("applies platform overrides, array argument expansion and boolean serialization", () => {
    const manifest = parseMcpbManifest(manifestFixture(), "win32");
    const launch = resolveMcpbLaunch(manifest, {
      directory: "C:\\bundles\\fixture",
      platform: "win32",
      variables: {},
      config: { token: "fixture-secret", directories: ["C:\\one", "C:\\two"] },
    });
    expect(launch.command).toBe("node.exe");
    expect(launch.args).toEqual(["C:\\bundles\\fixture/server/index.js", "C:\\one", "C:\\two"]);
    expect(launch.env).toEqual({
      API_TOKEN: "fixture-secret",
      VERBOSE: "false",
      PLATFORM: "windows",
    });
  });
  it("expands portable defaults and rejects unresolved or embedded array placeholders", () => {
    const manifest = parseMcpbManifest(manifestFixture());
    manifest.user_config.directories!.default = ["${HOME}/Documents"];
    const input = {
      directory: "/bundles/fixture",
      platform: "linux" as const,
      variables: { HOME: "/fixtures" },
      config: { token: "fixture-token" },
    };
    expect(resolveMcpbLaunch(manifest, input).args[1]).toBe("/fixtures/Documents");
    manifest.server.mcp_config.args = ["--paths=${user_config.directories}"];
    expect(() => resolveMcpbLaunch(manifest, input)).toThrow("separate argument");
    manifest.server.mcp_config.args = ["${UNDECLARED}"];
    expect(() => resolveMcpbLaunch(manifest, input)).toThrow("Complete configuration");
  });
});
