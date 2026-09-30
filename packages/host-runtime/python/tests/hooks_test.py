"""The table-driven hook guard matches the original hard-coded guard exactly.

Stubs are inert classes and functions built from the compatibility table's
own signature data — no Hermes code is imported or executed.
"""

from __future__ import annotations

import inspect
import itertools
import json
import linecache
from pathlib import Path
import sys
import types
import unittest
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hermes_launcher import check_hooks, harden_constructed_agent, load_compat


ENTRY = load_compat()["entries"]["daaffc303ae437041b7f76be17c5f61b14f2ce99"]
NEW_ENTRY = load_compat()["entries"]["5849eacde63aaea608ca418821cc84771fce3bec"]
_COUNTER = itertools.count()


def exec_sourced(source: str) -> dict:
    """Exec generated source with a linecache entry so inspect.getsource works."""
    namespace: dict = {}
    filename = f"<hermes-stub-{next(_COUNTER)}>"
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
    exec(compile(source, filename, "exec"), namespace)
    return namespace


def build_stub_modules(entry: dict) -> tuple:
    """Build inert session/server/run_agent modules from table signature data."""
    make_params = entry["sessionHook"]["parameters"]
    signature = ", ".join(
        f"{name}" if kind == "POSITIONAL_OR_KEYWORD" else f"{name}=None"
        for name, kind in make_params[1:]
    )
    body = "".join(f"        {needle}\n" for needle in entry["sourceGuard"]["mustContain"])
    make_source = (
        f"class SessionManager:\n"
        f"    def _make_agent(self, *, {signature}):\n"
        f"{body}"
    )
    helper_params = [name for name, _kind in entry["toolsetHelper"]["parameters"]]
    helper_source = (
        f"class SessionModule:\n"
        f"    SessionManager = SessionManager\n"
        f"    @staticmethod\n"
        f"    def _expand_acp_enabled_toolsets({', '.join(helper_params)}):\n"
        f"        return []\n"
    )
    acp_params = [name for name, _kind in entry["acpAgentInit"]["parameters"]]
    acp_source = (
        f"class HermesACPAgent:\n"
        f"    def __init__({', '.join(acp_params)}):\n"
        f"        self.session_manager = session_manager\n"
    )
    init_params = ["self"] + sorted(
        set(entry["agentInit"]["required"]) | {entry["callbacks"]["setup_mcp_callback"]})
    init_params += [f"extra_{index}" for index in range(entry["agentInit"]["parameterCount"] - len(init_params))]
    agent_source = f"class AIAgent:\n    def __init__({', '.join(init_params)}):\n        pass\n"

    namespace = exec_sourced(
        make_source + "\n" + helper_source + "\n" + acp_source + "\n" + agent_source)
    session = types.ModuleType("fake_session")
    server = types.ModuleType("fake_server")
    run_agent = types.ModuleType("fake_run_agent")
    session.SessionManager = namespace["SessionManager"]
    session._expand_acp_enabled_toolsets = getattr(namespace["SessionModule"], "_expand_acp_enabled_toolsets")
    server.HermesACPAgent = namespace["HermesACPAgent"]
    run_agent.AIAgent = namespace["AIAgent"]
    return session, server, run_agent


def with_make_source(entry: dict, body: str, signature: str | None = None) -> tuple:
    session, server, run_agent = build_stub_modules(entry)
    make_params = entry["sessionHook"]["parameters"]
    if signature is None:
        signature = ", ".join(
            f"{name}" if kind == "POSITIONAL_OR_KEYWORD" else f"{name}=None"
            for name, kind in make_params[1:])
    namespace = exec_sourced(
        f"class SessionManager:\n    def _make_agent(self, *, {signature}):\n{body}\n")
    session.SessionManager = namespace["SessionManager"]
    return session, server, run_agent


def reference_check_hooks(session, server, run_agent) -> None:
    """The original hard-coded guard, kept verbatim from the pre-table launcher."""
    make = session.SessionManager._make_agent
    signature = inspect.signature(make)
    if list(signature.parameters) != [
        "self", "session_id", "cwd", "model", "requested_provider", "base_url", "api_mode"
    ]:
        raise RuntimeError("Session hook signature changed")
    if not all(signature.parameters[name].kind is inspect.Parameter.KEYWORD_ONLY for name in list(signature.parameters)[1:]):
        raise RuntimeError("Session hook is no longer keyword-only")
    source = inspect.getsource(make)
    if not ('"hermes-acp"' in source and "disabled_toolsets" not in source):
        raise RuntimeError("Session hook behavior changed")
    if list(inspect.signature(session._expand_acp_enabled_toolsets).parameters) != ["toolsets", "mcp_server_names"]:
        raise RuntimeError("Toolset helper changed")
    if list(inspect.signature(server.HermesACPAgent.__init__).parameters) != ["self", "session_manager"]:
        raise RuntimeError("ACP injection changed")
    parameters = inspect.signature(run_agent.AIAgent.__init__).parameters
    if not (len(parameters) == 81 and {"base_url", "api_key", "provider", "api_mode", "model", "max_iterations", "enabled_toolsets", "disabled_toolsets", "save_trajectories", "skip_context_files", "skip_memory", "skip_background_review", "run_budget_seconds", "fallback_model"} <= parameters.keys()):
        raise RuntimeError("Agent constructor changed")


def outcome(function, modules) -> str:
    try:
        function(*modules)
    except RuntimeError as error:
        return str(error)
    return "PASS"


class HookTests(unittest.TestCase):
    def test_table_guard_passes_the_old_pin_stubs(self):
        check_hooks(*build_stub_modules(ENTRY), ENTRY)

    def test_table_guard_matches_the_original_guard_byte_for_byte(self):
        old_params = "session_id, cwd, model=None, requested_provider=None, base_url=None, api_mode=None"
        variants = [
            build_stub_modules(ENTRY),
            # Hook parameters became positional instead of keyword-only.
            with_make_source(ENTRY, '        return ["hermes-acp"]', signature=old_params),
            # Hook gained a parameter.
            with_make_source(ENTRY, '        return ["hermes-acp"]',
                             signature=old_params + ", extra=None"),
        ]
        session, server, run_agent = build_stub_modules(ENTRY)
        session._expand_acp_enabled_toolsets = (
            lambda toolsets, renamed: None)
        variants.append((session, server, run_agent))

        def changed_acp_init(_session, server, _run_agent):
            server.HermesACPAgent.__init__.__signature__ = inspect.Signature(
                list(inspect.signature(server.HermesACPAgent.__init__).parameters.values()) + [
                    inspect.Parameter("extra", inspect.Parameter.POSITIONAL_OR_KEYWORD)])
        session, server, run_agent = build_stub_modules(ENTRY)
        changed_acp_init(session, server, run_agent)
        variants.append((session, server, run_agent))

        def with_agent_signature(mutate):
            session, server, run_agent = build_stub_modules(ENTRY)
            signature = mutate(list(inspect.signature(run_agent.AIAgent.__init__).parameters.values()))
            run_agent.AIAgent.__init__.__signature__ = inspect.Signature(signature)
            return session, server, run_agent

        variants.append(with_agent_signature(lambda params: params[:-1]))
        variants.append(with_agent_signature(lambda params: [
            p for p in params if p.name != "fallback_model"]))

        for index, modules in enumerate(variants):
            with self.subTest(variant=index):
                self.assertEqual(
                    outcome(lambda *m: check_hooks(*m, ENTRY), modules),
                    outcome(reference_check_hooks, modules))

    def test_source_guard_rejects_disabled_toolsets(self):
        modules = with_make_source(ENTRY, "        return ['hermes-acp', 'disabled_toolsets']")
        with self.assertRaisesRegex(RuntimeError, "Session hook behavior changed"):
            check_hooks(*modules, ENTRY)

    def test_callback_presence_is_checked(self):
        session, server, run_agent = build_stub_modules(ENTRY)
        params = inspect.signature(run_agent.AIAgent.__init__).parameters
        run_agent.AIAgent.__init__.__signature__ = inspect.Signature([
            inspect.Parameter("connection_callback", p.kind) if p.name == "setup_mcp_callback" else p
            for p in params.values()])
        with self.assertRaisesRegex(RuntimeError, "Agent MCP callback changed"):
            check_hooks(session, server, run_agent, ENTRY)


class NewEntryTests(unittest.TestCase):
    def test_new_entry_guard_passes_stubs_built_from_its_signatures(self):
        check_hooks(*build_stub_modules(NEW_ENTRY), NEW_ENTRY)

    def test_new_entry_source_guard_requires_toolset_threading(self):
        modules = with_make_source(NEW_ENTRY, '        return ["hermes-acp"]')
        with self.assertRaisesRegex(RuntimeError, "Session hook behavior changed"):
            check_hooks(*modules, NEW_ENTRY)

    def test_new_entry_rejects_the_old_hooks(self):
        modules = build_stub_modules(ENTRY)
        with self.assertRaisesRegex(RuntimeError, "Session hook signature changed"):
            check_hooks(*modules, NEW_ENTRY)

    def test_old_entry_rejects_the_new_hooks(self):
        modules = build_stub_modules(NEW_ENTRY)
        with self.assertRaisesRegex(RuntimeError, "Session hook signature changed"):
            check_hooks(*modules, ENTRY)


class ConstructedAgentTests(unittest.TestCase):
    def agent(self, enabled=None, disabled=None, callback=None):
        return SimpleNamespace(enabled_toolsets=enabled, disabled_toolsets=disabled,
                               connection_callback=callback)

    def server(self, **overrides):
        values = {"name": "ardur", "transport": "http", "command": None,
                  "url": "http://127.0.0.1:9/mcp", "args": ["--relay"]}
        values.update(overrides)
        return SimpleNamespace(**values)

    def manager(self, accepted=None):
        return SimpleNamespace(_ardur_mcp_server=accepted)

    def test_new_entry_asserts_exact_toolsets(self):
        agent = self.agent(["mcp-ardur"], ["hermes-acp"])
        harden_constructed_agent(agent, NEW_ENTRY)
        agent.enabled_toolsets = ["terminal"]
        with self.assertRaisesRegex(RuntimeError, "Constructed toolsets changed"):
            harden_constructed_agent(agent, NEW_ENTRY)
        agent.enabled_toolsets = ["mcp-ardur"]
        agent.disabled_toolsets = []
        with self.assertRaisesRegex(RuntimeError, "Constructed toolsets changed"):
            harden_constructed_agent(agent, NEW_ENTRY)

    def test_callback_guard_delegates_the_configured_server(self):
        calls = []

        def original(*args, **kwargs):
            calls.append((args, kwargs))
            return "attached"

        accepted = self.server()
        agent = self.agent(["mcp-ardur"], ["hermes-acp"], callback=original)
        harden_constructed_agent(agent, NEW_ENTRY, self.manager(accepted))
        self.assertEqual(agent.connection_callback(server=accepted), "attached")
        self.assertEqual(agent.connection_callback(accepted), "attached")
        self.assertEqual(len(calls), 2)

    def test_callback_guard_is_inert_without_an_original_callback(self):
        accepted = self.server()
        agent = self.agent(["mcp-ardur"], ["hermes-acp"])
        harden_constructed_agent(agent, NEW_ENTRY, self.manager(accepted))
        self.assertIsNone(agent.connection_callback(server=accepted))

    def test_callback_guard_refuses_a_server_ardur_did_not_configure(self):
        accepted = self.server()
        agent = self.agent(["mcp-ardur"], ["hermes-acp"])
        harden_constructed_agent(agent, NEW_ENTRY, self.manager(accepted))
        with self.assertRaisesRegex(RuntimeError, "MCP server attachment refused"):
            agent.connection_callback(server=self.server(url="https://unconfigured.invalid/mcp"))
        with self.assertRaisesRegex(RuntimeError, "MCP server attachment refused"):
            agent.connection_callback(server=self.server(args=["--other"]))
        with self.assertRaisesRegex(RuntimeError, "MCP server attachment refused"):
            agent.connection_callback(server=self.server(command="unexpected"))
        with self.assertRaisesRegex(RuntimeError, "MCP server attachment refused"):
            agent.connection_callback(server=SimpleNamespace(name="ardur"))

    def test_callback_guard_refuses_a_bare_name(self):
        accepted = self.server()
        agent = self.agent(["mcp-ardur"], ["hermes-acp"])
        harden_constructed_agent(agent, NEW_ENTRY, self.manager(accepted))
        with self.assertRaisesRegex(RuntimeError, "MCP server attachment refused"):
            agent.connection_callback(server="ardur")
        with self.assertRaisesRegex(RuntimeError, "MCP server attachment refused"):
            agent.connection_callback("ardur")
        with self.assertRaisesRegex(RuntimeError, "MCP server attachment refused"):
            agent.connection_callback(name="ardur")

    def test_callback_guard_refuses_conflicting_selectors(self):
        accepted = self.server()
        agent = self.agent(["mcp-ardur"], ["hermes-acp"])
        harden_constructed_agent(agent, NEW_ENTRY, self.manager(accepted))
        with self.assertRaisesRegex(RuntimeError, "MCP server attachment refused"):
            agent.connection_callback(self.server(name="other"), server=accepted)

    def test_callback_guard_refuses_without_an_accepted_server(self):
        agent = self.agent(["mcp-ardur"], ["hermes-acp"])
        harden_constructed_agent(agent, NEW_ENTRY)
        with self.assertRaisesRegex(RuntimeError, "MCP server attachment refused"):
            agent.connection_callback(server=self.server())
        harden_constructed_agent(agent, NEW_ENTRY, SimpleNamespace())
        with self.assertRaisesRegex(RuntimeError, "MCP server attachment refused"):
            agent.connection_callback(server=self.server())

    def test_old_entry_leaves_the_constructed_agent_untouched(self):
        agent = SimpleNamespace(enabled_toolsets=None, disabled_toolsets=None)
        harden_constructed_agent(agent, ENTRY)
        self.assertFalse(hasattr(agent, "connection_callback"))


if __name__ == "__main__":
    unittest.main()
