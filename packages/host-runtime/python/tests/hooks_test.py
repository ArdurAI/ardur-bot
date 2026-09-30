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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hermes_launcher import check_hooks, load_compat


ENTRY = load_compat()["entries"]["daaffc303ae437041b7f76be17c5f61b14f2ce99"]
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
    make_source = (
        f"class SessionManager:\n"
        f"    def _make_agent(self, *, {signature}):\n"
        f'        return ["hermes-acp"]\n'
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


if __name__ == "__main__":
    unittest.main()
