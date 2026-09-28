"""Offline profile checks using the same compiled fixture as the host tests."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hermes_profile import acknowledge, check_catalog, check_constructed, validate


FIXTURE = json.loads(Path(__file__).with_name("valid_profile.json").read_text())


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.envelope = copy.deepcopy(FIXTURE)
        self.config = copy.deepcopy(FIXTURE["effectiveRuntimeConfig"]["generatedConfig"])
        self.env = {
            "ARDUR_HERMES_PROFILE": "hermes-ardur-v2",
            "ARDUR_HERMES_EXPECTED_HASH": FIXTURE["effectiveRuntimeConfigHash"],
            "ARDUR_HERMES_MODEL": "fixture-model",
            "ARDUR_HERMES_MAX_TOKENS": "1024",
            "ARDUR_HERMES_MAX_ITERATIONS": "16",
            "ARDUR_HERMES_RUN_BUDGET_SECONDS": "180",
            "ARDUR_HERMES_ALLOWED_TOOLS": '["mcp__ardur__fixture_echo"]',
            "HERMES_DISABLE_LAZY_INSTALLS": "1",
            "PATH": "/usr/bin:/bin",
        }

    def write(self):
        for name, value in (("runtime-manifest.json", self.envelope), ("config.yaml", self.config)):
            target = self.home / name
            target.write_text(json.dumps(value))
            target.chmod(0o600)

    def test_compiled_fixture_and_acknowledgment(self):
        self.write()
        profile = validate(self.home, self.env)
        self.assertEqual(profile["allowedTools"], ["mcp__ardur__fixture_echo"])
        acknowledge(self.home, profile["hash"], "fixture-session")
        self.assertEqual(json.loads((self.home / "runtime-ack.json").read_text()), {
            "profile": "hermes-ardur-v2", "configurationHash": profile["hash"],
            "sessionId": "fixture-session",
        })
        with self.assertRaises(FileExistsError):
            acknowledge(self.home, profile["hash"], "another-session")

    def test_forged_hash_and_policy_are_denied(self):
        for mutation in (
            lambda: self.envelope.update(effectiveRuntimeConfigHash="0" * 64),
            lambda: self.envelope["effectiveRuntimeConfig"]["generatedConfig"]["compression"].update(enabled=True),
            lambda: self.envelope["runtimeConfig"]["harness"]["agent"].update(api_max_retries=4),
            lambda: self.envelope["effectiveRuntimeConfig"]["profile"].update(profile="other"),
            lambda: self.envelope["effectiveRuntimeConfig"]["generatedConfig"].update(mcp_servers={"other": {}}),
        ):
            with self.subTest(mutation=mutation.__code__.co_firstlineno):
                self.envelope = copy.deepcopy(FIXTURE)
                mutation()
                self.write()
                with self.assertRaises(RuntimeError):
                    validate(self.home, self.env)

    def test_tampered_file_environment_and_symlink_are_denied(self):
        self.write()
        self.config["security"]["allow_lazy_installs"] = True
        self.write()
        with self.assertRaises(RuntimeError):
            validate(self.home, self.env)
        self.config = copy.deepcopy(FIXTURE["effectiveRuntimeConfig"]["generatedConfig"])
        self.write()
        self.env["ARDUR_HERMES_MAX_ITERATIONS"] = "64"
        with self.assertRaises(RuntimeError):
            validate(self.home, self.env)
        self.env["ARDUR_HERMES_MAX_ITERATIONS"] = "16"
        (self.home / "config.yaml").unlink()
        (self.home / "config.yaml").symlink_to(self.home / "runtime-manifest.json")
        with self.assertRaises(OSError):
            validate(self.home, self.env)

    def test_duplicate_and_public_files_are_denied(self):
        self.write()
        target = self.home / "runtime-manifest.json"
        target.write_text('{"runtimeKind":"hermes","runtimeKind":"hermes"}')
        with self.assertRaises(RuntimeError):
            validate(self.home, self.env)
        self.write()
        target.chmod(0o644)
        with self.assertRaises(RuntimeError):
            validate(self.home, self.env)

    def test_constructed_limits_and_exact_catalog(self):
        manifest = FIXTURE["effectiveRuntimeConfig"]
        agent = SimpleNamespace(model="fixture-model", max_iterations=16,
                                run_budget_seconds=180, _api_max_retries=1,
                                compression_enabled=False, _memory_enabled=False,
                                _user_profile_enabled=False, skip_background_review=True,
                                _skip_mcp_refresh=True,
                                provider="custom", api_mode="chat_completions",
                                enabled_toolsets=["mcp-ardur"],
                                tools=[{"function": {"name": "mcp__ardur__fixture_echo"}}])
        check_constructed(agent, manifest)
        check_catalog(agent, ["mcp__ardur__fixture_echo"])
        agent.compression_enabled = True
        with self.assertRaises(RuntimeError):
            check_constructed(agent, manifest)
        agent.compression_enabled = False
        agent._api_max_retries = 3
        with self.assertRaises(RuntimeError):
            check_constructed(agent, manifest)
        agent._api_max_retries = 1
        agent.tools.append({"function": {"name": "terminal"}})
        with self.assertRaises(RuntimeError):
            check_catalog(agent, ["mcp__ardur__fixture_echo"])


if __name__ == "__main__":
    unittest.main()
