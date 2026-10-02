import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import sourceHashes from "../../python/hermes_sources.json" with { type: "json" };
import compatFixtures from "../../python/tests/compat_fixtures.json" with { type: "json" };
import type { HermesCompatTable } from "./hermes-compat.js";
import {
  assertCompatTableValid,
  assertHermesCompatInStep,
  HERMES_COMPAT,
  HERMES_COMPAT_PINNED,
  hermesCompatPinnedSources,
  hermesCompatSourcePaths,
} from "./hermes-compat.js";
import { HERMES_SOURCE_PIN, HERMES_SOURCE_TREE } from "./hermes-install.js";

describe("hermes compatibility table", () => {
  it("keeps the table, the source pin and the launcher hashes in step", () => {
    expect(() => assertHermesCompatInStep()).not.toThrow();
    expect(HERMES_COMPAT_PINNED?.commit).toBe(HERMES_SOURCE_PIN);
    expect(HERMES_COMPAT_PINNED?.tree).toBe(HERMES_SOURCE_TREE);
    expect(hermesCompatPinnedSources()).toEqual(sourceHashes);
  });

  it("keys every entry by its own tree and carries the launcher-checked files", () => {
    for (const [tree, entry] of Object.entries(HERMES_COMPAT.entries)) {
      expect(entry.tree).toBe(tree);
      expect(entry.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(Object.keys(entry.sources).sort()).toEqual(hermesCompatSourcePaths());
      for (const digest of Object.values(entry.sources)) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it("describes hooked signatures with kinds and the renamed callback", () => {
    for (const entry of Object.values(HERMES_COMPAT.entries)) {
      expect(entry.sessionHook.parameters[0]?.[0]).toBe("self");
      for (const [, kind] of entry.sessionHook.parameters.slice(1)) {
        expect(kind).toBe("KEYWORD_ONLY");
      }
      expect(entry.acpAgentInit.parameters[0]?.[0]).toBe("self");
      expect(entry.agentInit.parameterCount).toBeGreaterThanOrEqual(
        entry.agentInit.required.length,
      );
      for (const name of entry.agentInit.required) {
        expect(typeof name).toBe("string");
      }
      expect(entry.callbacks.setup_mcp_callback.length).toBeGreaterThan(0);
      expect(
        entry.sourceGuard.mustContain.length + entry.sourceGuard.mustNotContain.length,
      ).toBeGreaterThan(0);
      if (entry.constructedToolsets) {
        expect(entry.constructedToolsets.enabled.length).toBeGreaterThan(0);
        expect(entry.constructedToolsets.disabled.length).toBeGreaterThan(0);
        for (const name of [
          ...entry.constructedToolsets.enabled,
          ...entry.constructedToolsets.disabled,
        ]) {
          expect(typeof name).toBe("string");
        }
      }
    }
  });

  it("agrees with the Python validator on every shared fixture", () => {
    const collision = compatFixtures.invalid.find(
      (testCase) => testCase.name === "comma-colliding additional source keys",
    );
    if (!collision) throw new Error("Collision regression fixture is missing");
    const paths = Object.values((collision.table as HermesCompatTable).entries).map((entry) =>
      Object.keys(entry.sources).sort(),
    );
    expect(paths[0]).not.toEqual(paths[1]);
    expect(paths[0]?.join()).toBe(paths[1]?.join());
    for (const [index, table] of compatFixtures.valid.entries()) {
      expect(() => assertCompatTableValid(table), `valid fixture ${index}`).not.toThrow();
    }
    for (const testCase of compatFixtures.invalid) {
      expect(
        () => assertCompatTableValid(testCase.table),
        `invalid fixture: ${testCase.name}`,
      ).toThrow("Compatibility table is invalid");
    }
    const python = spawnSync(
      "python3",
      [
        "-B",
        "-c",
        [
          "import json, pathlib, sys",
          "sys.path.insert(0, sys.argv[1])",
          "from hermes_launcher import validate_compat",
          "fixtures = json.loads(pathlib.Path(sys.argv[2]).read_text())",
          "verdicts = []",
          "for table in fixtures['valid'] + [case['table'] for case in fixtures['invalid']]:",
          "    try:",
          "        validate_compat(table)",
          "        verdicts.append(True)",
          "    except RuntimeError:",
          "        verdicts.append(False)",
          "print(json.dumps(verdicts))",
        ].join("\n"),
        fileURLToPath(new URL("../../python", import.meta.url)),
        fileURLToPath(new URL("../../python/tests/compat_fixtures.json", import.meta.url)),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(python.error).toBeUndefined();
    expect(python.status, python.stderr).toBe(0);
    const tables = [
      ...compatFixtures.valid,
      ...compatFixtures.invalid.map((testCase) => testCase.table),
    ];
    const verdicts = tables.map((table) => {
      try {
        assertCompatTableValid(table);
        return true;
      } catch {
        return false;
      }
    });
    expect(JSON.parse(python.stdout)).toEqual(verdicts);
  });

  it("qualifies v2026.9.24 without making constructed-agent assertions optional", () => {
    const qualified = HERMES_COMPAT.entries["5849eacde63aaea608ca418821cc84771fce3bec"];
    expect(qualified?.version).toBe("v2026.9.24");
    expect(qualified?.agentInit.parameterCount).toBe(85);
    expect(qualified?.sessionHook.parameters.map(([name]) => name)).toContain("disabled_toolsets");
    expect(qualified?.callbacks.setup_mcp_callback).toBe("connection_callback");
    expect(qualified?.constructedToolsets).toEqual({
      enabled: ["mcp-ardur"],
      disabled: ["hermes-acp"],
    });
    const pinned = HERMES_COMPAT.entries[HERMES_SOURCE_TREE];
    expect(pinned?.constructedToolsets).toEqual(qualified?.constructedToolsets);
  });
});
