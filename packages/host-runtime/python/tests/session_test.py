"""Exercise the owned session classes with inert dependencies, never upstream code."""

from __future__ import annotations

import ast
import asyncio
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hermes_launcher
from hermes_profile import validate

FIXTURE = json.loads(Path(__file__).with_name("valid_profile.json").read_text())


class SessionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        manifest = FIXTURE["effectiveRuntimeConfig"]
        for name, value in (("runtime-manifest.json", FIXTURE),
                            ("config.yaml", manifest["generatedConfig"])):
            target = self.home / name
            target.write_text(json.dumps(value))
            target.chmod(0o600)
        self.profile = validate(self.home, {
            "ARDUR_HERMES_PROFILE": "hermes-ardur-v2",
            "ARDUR_HERMES_EXPECTED_HASH": FIXTURE["effectiveRuntimeConfigHash"],
            "ARDUR_HERMES_MODEL": "fixture-model",
            "ARDUR_HERMES_MAX_TOKENS": "1024",
            "ARDUR_HERMES_MAX_ITERATIONS": "16",
            "ARDUR_HERMES_RUN_BUDGET_SECONDS": "180",
            "ARDUR_HERMES_ALLOWED_TOOLS": '["mcp__ardur__fixture_echo"]',
            "HERMES_DISABLE_LAZY_INSTALLS": "1",
            "PATH": "/usr/bin:/bin",
        })
        self.attachments = []
        self.prompts = []
        self.disabled_override = None
        self.extra_tool = False
        tree = ast.parse(Path(hermes_launcher.__file__).read_text())
        self.classes: list[ast.stmt] = [node for node in ast.walk(tree)
                        if isinstance(node, ast.ClassDef) and
                        node.name in ("ArdurSessionManager", "ArdurACPAgent")]
        self.assertEqual(len(self.classes), 2)

    def owned_session(self, entry, profile=True):
        owner = self

        class SessionManager:
            def __init__(self):
                self._sessions = {}

            def _get_db(self):
                return None

        class ACPAgent:
            def __init__(self, session_manager):
                self.session_manager = session_manager

            async def new_session(self, cwd, mcp_servers=None, **kwargs):
                agent = self.session_manager._make_agent(session_id="fixture-session", cwd=cwd)
                self.session_manager._sessions["fixture-session"] = SimpleNamespace(agent=agent)
                return SimpleNamespace(session_id="fixture-session")

            async def prompt(self, prompt, session_id, **kwargs):
                owner.prompts.append(prompt)
                return "prompt accepted"

        def construct(**kwargs):
            agent = SimpleNamespace(**kwargs, _api_max_retries=1, compression_enabled=False,
                                    _memory_enabled=False, _user_profile_enabled=False,
                                    tools=[{"function": {"name": "mcp__ardur__fixture_echo"}}])
            if owner.disabled_override is not None:
                agent.disabled_toolsets = owner.disabled_override
            if owner.extra_tool:
                agent.tools.append({"function": {"name": "terminal"}})
            callback = lambda server: owner.attachments.append(server)
            agent.setup_mcp_callback = callback
            agent.connection_callback = callback
            return agent

        namespace = {
            **vars(hermes_launcher),
            "session": SimpleNamespace(SessionManager=SessionManager, _acp_stderr_print=lambda *args: None),
            "server": SimpleNamespace(HermesACPAgent=ACPAgent),
            "run_agent": SimpleNamespace(AIAgent=construct),
            "entry": entry,
            "session_parameters": {name for name, _kind in entry["sessionHook"]["parameters"]} - {"self"},
            "expected_model": "fixture-model", "route": "http://127.0.0.1:9/v1",
            "token": "fixture-grant", "max_iterations": 16, "run_budget_seconds": 180,
            "max_tokens": 1024, "profile": self.profile if profile else None, "home": self.home,
        }
        module = ast.Module(body=self.classes, type_ignores=[])
        exec(compile(module, "<owned-session-classes>", "exec"), namespace)
        return namespace["ArdurACPAgent"](namespace["ArdurSessionManager"]())

    def configured_server(self):
        return SimpleNamespace(name="ardur", transport="stdio", command="fixture-mcp",
                               args=["--relay"], url=None, headers=[],
                               env=[SimpleNamespace(name="FIXTURE", value="configured")])

    def test_owned_session_refuses_substituted_environment_before_delegation(self):
        entry = hermes_launcher.COMPAT["entries"]["5849eacde63aaea608ca418821cc84771fce3bec"]
        acp = self.owned_session(entry)
        accepted = self.configured_server()
        response = asyncio.run(acp.new_session("/fixture/workspace", mcp_servers=[accepted]))
        agent = acp.session_manager._sessions[response.session_id].agent
        hermes_launcher.check_constructed(agent, self.profile["manifest"])
        hermes_launcher.check_catalog(agent, self.profile["allowedTools"])
        agent.connection_callback(copy.deepcopy(accepted))
        substituted = copy.deepcopy(accepted)
        substituted.env.append(SimpleNamespace(name="NODE_OPTIONS", value="--require /fixture/unconfigured-hook.cjs"))
        with self.assertRaisesRegex(RuntimeError, "MCP server attachment refused"):
            agent.connection_callback(substituted)
        self.assertEqual(len(self.attachments), 1)
        self.assertEqual(self.prompts, [])
        self.assertEqual(asyncio.run(acp.prompt("fixture prompt", response.session_id)), "prompt accepted")
        acknowledgment = json.loads((self.home / "runtime-ack.json").read_text())
        self.assertEqual(acknowledgment["sessionId"], response.session_id)

    def test_owned_session_cannot_skip_disabled_toolset_assertions(self):
        self.disabled_override = []
        for entry in hermes_launcher.COMPAT["entries"].values():
            for profile in (False, True):
                with self.subTest(version=entry["version"], profile=profile):
                    acp = self.owned_session(entry, profile=profile)
                    with self.assertRaisesRegex(RuntimeError, "Constructed toolsets changed"):
                        asyncio.run(acp.new_session("/fixture/workspace", mcp_servers=[self.configured_server()]))
        self.assertEqual(self.attachments, [])
        self.assertEqual(self.prompts, [])
        self.assertFalse((self.home / "runtime-ack.json").exists())

    def test_owned_session_refuses_an_extra_tool_before_acknowledgment(self):
        self.extra_tool = True
        entry = hermes_launcher.COMPAT["entries"]["5849eacde63aaea608ca418821cc84771fce3bec"]
        acp = self.owned_session(entry)
        with self.assertRaisesRegex(RuntimeError, "Constructed tool catalog changed"):
            asyncio.run(acp.new_session("/fixture/workspace", mcp_servers=[self.configured_server()]))
        self.assertEqual(self.attachments, [])
        self.assertEqual(self.prompts, [])
        self.assertFalse((self.home / "runtime-ack.json").exists())


if __name__ == "__main__":
    unittest.main()
