"""Pinned ACP entry for one Ardur turn. The install is trusted native code."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import inspect
import os
from pathlib import Path
import subprocess
import sys
import json

from hermes_profile import acknowledge, check_catalog, check_constructed, validate


PIN = "29112bef099274229cadff79cdff7bf7b99c4b77"
TREE = "daaffc303ae437041b7f76be17c5f61b14f2ce99"

# The table supplies expectations, never the minimum set of checks.
MANDATORY_SOURCE_PATHS = frozenset({
    "acp_adapter/session.py", "acp_adapter/server.py", "acp_adapter/entry.py",
    "run_agent.py", "pyproject.toml", "uv.lock", "hermes_cli/config_defaults.py",
    "hermes_cli/config.py", "agent/agent_init.py", "agent/prompt_builder.py",
    "agent/conversation_loop.py", "agent/turn_context.py", "tools/mcp_tool.py",
    "model_tools.py", "tools/registry.py",
})
ENABLED_TOOLSETS = ("mcp-ardur",)
DISABLED_TOOLSETS = ("hermes-acp",)
CONSTRUCTED_TOOLSET_FIELDS = frozenset({"enabled", "disabled"})

ENTRY_FIELDS = {
    "version", "commit", "tree", "sources", "sessionHook", "toolsetHelper",
    "acpAgentInit", "agentInit", "sourceGuard", "callbacks", "constructedToolsets",
}
HOOK_FIELDS = {"parameters"}
PARAMETER_KINDS = {
    "POSITIONAL_ONLY", "POSITIONAL_OR_KEYWORD", "VAR_POSITIONAL",
    "KEYWORD_ONLY", "VAR_KEYWORD",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def _is_hex(value: object, length: int) -> bool:
    return (type(value) is str and len(value) == length and
            all(character in "0123456789abcdef" for character in value))


def _is_string_list(value: object, *, non_empty: bool = False) -> bool:
    return (type(value) is list and (not non_empty or bool(value)) and
            all(type(item) is str for item in value))


def _is_json_integer(value: object) -> bool:
    """JSON numbers use the same safe integral-value policy in both validators."""
    return (isinstance(value, (int, float)) and not isinstance(value, bool) and
            abs(value) <= 9007199254740991 and
            value == int(value))


def _check_hook(value: dict) -> None:
    require(type(value) is dict and set(value) == HOOK_FIELDS,
            "Compatibility table is invalid")
    parameters = value["parameters"]
    require(type(parameters) is list and bool(parameters) and
            all(type(pair) is list and len(pair) == 2 and type(pair[0]) is str and
                type(pair[1]) is str and pair[1] in PARAMETER_KINDS for pair in parameters),
            "Compatibility table is invalid")


def validate_compat(data: dict) -> dict:
    """Validate the reviewed per-tree compatibility table, refusing any defect.

    Every entry must cover the launcher-owned mandatory sources and
    constructed expectations. Additional sources may strengthen coverage;
    missing, extra or malformed fields refuse the whole table.
    """
    require(type(data) is dict and set(data) == {"format", "entries"},
            "Compatibility table is invalid")
    require(_is_json_integer(data["format"]) and data["format"] == 1,
            "Compatibility table is invalid")
    entries = data["entries"]
    require(type(entries) is dict and bool(entries), "Compatibility table is invalid")
    source_paths: set | None = None
    for tree, entry in entries.items():
        require(type(tree) is str and _is_hex(tree, 40) and type(entry) is dict,
                "Compatibility table is invalid")
        require(set(entry) == ENTRY_FIELDS,
                "Compatibility table is invalid")
        require(type(entry["version"]) is str and bool(entry["version"]) and
                entry["tree"] == tree and _is_hex(entry["commit"], 40),
                "Compatibility table is invalid")
        sources = entry["sources"]
        require(type(sources) is dict and bool(sources) and
                all(type(name) is str and _is_hex(digest, 64)
                    for name, digest in sources.items()),
                "Compatibility table is invalid")
        paths = set(sources)
        require(MANDATORY_SOURCE_PATHS <= paths and
                (source_paths is None or paths == source_paths),
                "Compatibility table is invalid")
        source_paths = paths
        for hook in ("sessionHook", "toolsetHelper", "acpAgentInit"):
            _check_hook(entry[hook])
        require(entry["sessionHook"]["parameters"][0][0] == "self" and
                entry["acpAgentInit"]["parameters"][0][0] == "self",
                "Compatibility table is invalid")
        agent_init = entry["agentInit"]
        require(type(agent_init) is dict and set(agent_init) == {"parameterCount", "required"},
                "Compatibility table is invalid")
        require(_is_json_integer(agent_init["parameterCount"]) and agent_init["parameterCount"] >= 0 and
                _is_string_list(agent_init["required"], non_empty=True) and
                agent_init["parameterCount"] >= len(agent_init["required"]),
                "Compatibility table is invalid")
        guard = entry["sourceGuard"]
        require(type(guard) is dict and set(guard) == {"mustContain", "mustNotContain"} and
                _is_string_list(guard["mustContain"]) and
                _is_string_list(guard["mustNotContain"]) and
                bool(guard["mustContain"] + guard["mustNotContain"]),
                "Compatibility table is invalid")
        callbacks = entry["callbacks"]
        require(type(callbacks) is dict and set(callbacks) == {"setup_mcp_callback"} and
                type(callbacks["setup_mcp_callback"]) is str and callbacks["setup_mcp_callback"],
                "Compatibility table is invalid")
        constructed = entry["constructedToolsets"]
        require(type(constructed) is dict and set(constructed) == CONSTRUCTED_TOOLSET_FIELDS and
                constructed["enabled"] == list(ENABLED_TOOLSETS) and
                constructed["disabled"] == list(DISABLED_TOOLSETS),
                "Compatibility table is invalid")
    return data


def load_compat() -> dict:
    """Load the reviewed per-tree compatibility table and validate it strictly."""
    return validate_compat(
        json.loads(Path(__file__).with_name("hermes_compat.json").read_text(encoding="utf-8")))


COMPAT = load_compat()


def compat_entry(pin: str, tree: str) -> dict | None:
    for entry in COMPAT["entries"].values():
        if entry["commit"] == pin and entry["tree"] == tree:
            return entry
    return None


def entry_for_commit(commit: str) -> dict | None:
    for entry in COMPAT["entries"].values():
        if entry["commit"] == commit:
            return entry
    return None


def has_git_metadata(root: Path) -> bool:
    try:
        (root / ".git").lstat()
    except OSError:
        return False
    return True


def check_install(root: Path, home: Path) -> dict:
    require(root.is_absolute() and root.is_dir(), "Install root is unavailable")
    require(home.is_absolute() and home.is_dir() and home != root, "Private home is required")
    require(root not in home.parents, "Private home overlaps the install")
    require(not (root / ".env").exists(), "Install has a project dotenv")
    require(not (home / ".env").exists(), "Private home has a dotenv")
    require((root / ".venv/bin/python").resolve() == Path(sys.executable).resolve(), "Interpreter differs from install")
    if has_git_metadata(root):
        revision = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True, timeout=5,
        ).stdout.strip()
        entry = entry_for_commit(revision)
        require(entry is not None, "Install revision changed")
    else:
        marker_path = root / ".ardur-install.json"
        require(marker_path.is_file(), "Install marker is missing")
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError("Install marker mismatch") from error
        entry = compat_entry(marker.get("pin"), marker.get("tree")) if isinstance(marker, dict) else None
        require(entry is not None, "Install marker mismatch")
    for name in sorted(MANDATORY_SOURCE_PATHS | entry["sources"].keys()):
        expected = entry["sources"][name]
        require(hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, f"Install source changed: {name}")
    return entry


def check_hooks(session, server, run_agent, entry: dict) -> None:
    make = session.SessionManager._make_agent
    signature = inspect.signature(make)
    parameters = entry["sessionHook"]["parameters"]
    require([name for name, _kind in parameters] == list(signature.parameters), "Session hook signature changed")
    require(all(signature.parameters[name].kind is inspect.Parameter.KEYWORD_ONLY for name in list(signature.parameters)[1:]), "Session hook is no longer keyword-only")
    require(all(signature.parameters[name].kind.name == kind for name, kind in parameters), "Session hook signature changed")
    source = inspect.getsource(make)
    require(all(needle in source for needle in entry["sourceGuard"]["mustContain"]) and
            all(needle not in source for needle in entry["sourceGuard"]["mustNotContain"]),
            "Session hook behavior changed")
    require(list(inspect.signature(session._expand_acp_enabled_toolsets).parameters) ==
            [name for name, _kind in entry["toolsetHelper"]["parameters"]], "Toolset helper changed")
    require(list(inspect.signature(server.HermesACPAgent.__init__).parameters) ==
            [name for name, _kind in entry["acpAgentInit"]["parameters"]], "ACP injection changed")
    agent_parameters = inspect.signature(run_agent.AIAgent.__init__).parameters
    require(len(agent_parameters) == entry["agentInit"]["parameterCount"] and
            set(entry["agentInit"]["required"]) <= agent_parameters.keys(), "Agent constructor changed")
    callback = entry["callbacks"]["setup_mcp_callback"]
    require(callback in agent_parameters or hasattr(run_agent.AIAgent, callback), "Agent MCP callback changed")


def _mcp_named_values(values: object) -> tuple | None:
    """Snapshot complete ACP name/value lists or mappings without losing duplicates."""
    if values is None:
        return ()
    if type(values) is dict:
        pairs = list(values.items())
    elif type(values) is list:
        pairs = [(getattr(item, "name", None), getattr(item, "value", None)) for item in values]
    else:
        return None
    if (any(type(name) is not str or type(value) is not str for name, value in pairs) or
            len({name for name, _value in pairs}) != len(pairs)):
        return None
    return tuple(sorted(pairs))


def mcp_server_config(server: object) -> tuple | None:
    """Immutable identity, transport, endpoint, argv, environment and headers."""
    if server is None or isinstance(server, str):
        return None
    name = getattr(server, "name", None)
    transport = getattr(server, "transport", None)
    command = getattr(server, "command", None)
    url = getattr(server, "url", None)
    args = getattr(server, "args", None)
    env = _mcp_named_values(getattr(server, "env", None))
    headers = _mcp_named_values(getattr(server, "headers", None))
    if (type(name) is not str or not name or not (command or url) or
            any(value is not None and type(value) is not str for value in (transport, command, url)) or
            (args is not None and not _is_string_list(args)) or env is None or headers is None):
        return None
    return (
        name, transport, command, url, tuple(args or ()), env, headers,
    )


def harden_constructed_agent(agent, entry: dict, session_manager=None) -> None:
    """Prove the constructed agent enforces Ardur's toolset restriction.

    Toolset assertions and the MCP guard always run, including for the
    original pin. The table cannot select which assertions run.
    """
    require(getattr(agent, "enabled_toolsets", None) == list(ENABLED_TOOLSETS) and
            getattr(agent, "disabled_toolsets", None) == list(DISABLED_TOOLSETS),
            "Constructed toolsets changed")
    callback_name = entry["callbacks"]["setup_mcp_callback"]
    original = getattr(agent, callback_name, None)
    require(original is None or callable(original), "MCP attach callback is invalid")
    accepted = getattr(session_manager, "_ardur_mcp_config", None)

    def ardur_guarded_connect(*args, **kwargs):
        server = kwargs["server"] if "server" in kwargs else (args[0] if args else None)
        presented = mcp_server_config(server)
        require(presented is not None and presented == accepted,
                "MCP server attachment refused")
        if "server" in kwargs and args:
            require(mcp_server_config(args[0]) == presented,
                    "MCP server attachment refused")
        if "name" in kwargs:
            require(kwargs["name"] == presented[0], "MCP server attachment refused")
        if original is None:
            return None
        return original(*args, **kwargs)

    setattr(agent, callback_name, ardur_guarded_connect)


def main() -> None:
    root = Path(os.environ["ARDUR_HERMES_INSTALL"]).resolve()
    home = Path(os.environ["HERMES_HOME"]).resolve()
    route = os.environ["ARDUR_HERMES_RELAY_URL"]
    model = os.environ["ARDUR_HERMES_MODEL"]
    max_tokens = int(os.environ["ARDUR_HERMES_MAX_TOKENS"])
    max_iterations = int(os.environ["ARDUR_HERMES_MAX_ITERATIONS"])
    run_budget_seconds = int(os.environ["ARDUR_HERMES_RUN_BUDGET_SECONDS"])
    token = os.environ.pop("ARDUR_HERMES_PROVIDER_KEY")
    require(route.startswith("http://127.0.0.1:") and route.endswith("/v1"), "Relay must be loopback")
    require(bool(token) and bool(model), "Broker grant and model are required")
    require(1 <= max_tokens <= 65536, "Model output limit is invalid")
    require(1 <= max_iterations <= 64, "Provider call limit is invalid")
    require(1 <= run_budget_seconds <= 600, "Run time limit is invalid")
    require(os.environ.get("PYTHONDONTWRITEBYTECODE") == "1", "Bytecode writes are forbidden")
    require(os.environ.get("HERMES_DISABLE_LAZY_INSTALLS") == "1" and
            os.environ.get("PATH") == "/usr/bin:/bin", "Runtime code acquisition is forbidden")
    profile = validate(home, os.environ) if os.environ.get("ARDUR_HERMES_PROFILE") else None
    entry = check_install(root, home)
    session_parameters = {name for name, _kind in entry["sessionHook"]["parameters"]} - {"self"}
    sys.path.insert(0, str(root))
    with contextlib.redirect_stdout(sys.stderr):
        import acp
        from acp_adapter import entry as acp_entry, server, session
        import run_agent

        check_hooks(session, server, run_agent, entry)
        acp_entry._setup_logging()

        class ArdurSessionManager(session.SessionManager):
            def _make_agent(self, **kwargs):
                require(set(kwargs) <= session_parameters, "Session hook arguments changed")
                require(kwargs.get("model") in (None, expected_model), "ACP model override refused")
                require(kwargs.get("requested_provider") in (None, "custom"), "ACP provider override refused")
                require(kwargs.get("base_url") in (None, route), "ACP route override refused")
                require(kwargs.get("api_mode") in (None, "chat_completions"), "ACP API override refused")
                if "enabled_toolsets" in session_parameters:
                    require(kwargs.get("enabled_toolsets") in (None, list(ENABLED_TOOLSETS)), "ACP toolset override refused")
                    require(kwargs.get("disabled_toolsets") in (None, list(DISABLED_TOOLSETS)), "ACP toolset override refused")
                agent = run_agent.AIAgent(
                    base_url=route, api_key=token, provider="custom", api_mode="chat_completions",
                    model=expected_model, max_iterations=max_iterations, run_budget_seconds=run_budget_seconds,
                    max_tokens=max_tokens,
                    enabled_toolsets=list(ENABLED_TOOLSETS), disabled_toolsets=list(DISABLED_TOOLSETS),
                    save_trajectories=False, skip_context_files=True, load_soul_identity=True,
                    skip_memory=True, skip_background_review=True, fallback_model=None,
                    checkpoints_enabled=False, quiet_mode=True, platform="acp",
                    session_id=kwargs["session_id"], session_db=self._get_db(),
                )
                agent.session_cwd = kwargs["cwd"]
                agent._print_fn = session._acp_stderr_print
                harden_constructed_agent(agent, entry, self)
                if profile:
                    agent._skip_mcp_refresh = True
                    check_constructed(agent, profile["manifest"])
                return agent

        class ArdurACPAgent(server.HermesACPAgent):
            def __init__(self, session_manager):
                super().__init__(session_manager=session_manager)
                self._session_created = False
                self._prompt_started = False

            def _schedule_mcp_late_refresh(self, state):
                return None

            async def new_session(self, cwd, mcp_servers=None, **kwargs):
                require(not self._session_created, "Only one ACP session is allowed")
                require(len(mcp_servers or []) == 1 and mcp_servers[0].name == "ardur", "Only the Ardur MCP server is allowed")
                configured = mcp_server_config(mcp_servers[0])
                require(configured is not None, "MCP server configuration is invalid")
                self.session_manager._ardur_mcp_config = configured
                self._session_created = True
                response = await super().new_session(cwd, mcp_servers=mcp_servers, **kwargs)
                if profile:
                    state = self.session_manager._sessions.get(response.session_id)
                    require(state is not None, "Constructed session is unavailable")
                    check_catalog(state.agent, profile["allowedTools"])
                    acknowledge(home, profile["hash"], response.session_id)
                return response

            async def prompt(self, prompt, session_id, **kwargs):
                require(self._session_created and not self._prompt_started, "Only one ACP prompt is allowed")
                if profile:
                    state = self.session_manager._sessions.get(session_id)
                    require(state is not None, "Constructed session is unavailable")
                    check_catalog(state.agent, profile["allowedTools"])
                self._prompt_started = True
                return await super().prompt(prompt, session_id, **kwargs)

            async def load_session(self, *args, **kwargs):
                raise RuntimeError("Session resume is unavailable")

            async def set_session_model(self, *args, **kwargs):
                raise RuntimeError("Model changes are unavailable")

            async def set_session_mode(self, *args, **kwargs):
                raise RuntimeError("Session mode changes are unavailable")

            async def set_config_option(self, *args, **kwargs):
                raise RuntimeError("Session configuration changes are unavailable")

            def _cmd_model(self, *args, **kwargs):
                raise RuntimeError("Model changes are unavailable")

        expected_model = model
        agent = ArdurACPAgent(session_manager=ArdurSessionManager())
    asyncio.run(acp.run_agent(agent, use_unstable_protocol=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Ardur Hermes launcher stopped: {error}", file=sys.stderr)
        raise SystemExit(1) from None
