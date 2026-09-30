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


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load_compat() -> dict:
    """Load the reviewed per-tree compatibility table and check its shape."""
    data = json.loads(Path(__file__).with_name("hermes_compat.json").read_text(encoding="utf-8"))
    require(type(data) is dict and data.get("format") == 1 and type(data.get("entries")) is dict,
            "Compatibility table is invalid")
    for tree, entry in data["entries"].items():
        require(type(entry) is dict and entry.get("tree") == tree and
                type(entry.get("version")) is str and
                type(entry.get("commit")) is str and len(entry["commit"]) == 40 and
                type(entry.get("sources")) is dict and
                all(type(name) is str and type(digest) is str and len(digest) == 64
                    for name, digest in entry["sources"].items()) and
                type(entry.get("sessionHook")) is dict and
                type(entry.get("toolsetHelper")) is dict and
                type(entry.get("acpAgentInit")) is dict and
                type(entry.get("agentInit")) is dict and
                type(entry.get("sourceGuard")) is dict and
                type(entry.get("callbacks")) is dict,
                "Compatibility table is invalid")
        for hook in ("sessionHook", "toolsetHelper", "acpAgentInit"):
            parameters = entry[hook]["parameters"]
            require(type(parameters) is list and parameters and
                    all(type(pair) is list and len(pair) == 2 and type(pair[0]) is str and
                        type(pair[1]) is str for pair in parameters),
                    "Compatibility table is invalid")
        require(entry["sessionHook"]["parameters"][0][0] == "self" and
                entry["acpAgentInit"]["parameters"][0][0] == "self",
                "Compatibility table is invalid")
        agent_init = entry["agentInit"]
        require(type(agent_init.get("parameterCount")) is int and
                type(agent_init.get("required")) is list and
                all(type(name) is str for name in agent_init["required"]),
                "Compatibility table is invalid")
        guard = entry["sourceGuard"]
        require(type(guard.get("mustContain")) is list and type(guard.get("mustNotContain")) is list and
                all(type(needle) is str for needle in guard["mustContain"] + guard["mustNotContain"]),
                "Compatibility table is invalid")
        require(type(entry["callbacks"].get("setup_mcp_callback")) is str,
                "Compatibility table is invalid")
        constructed = entry.get("constructedToolsets")
        require(constructed is None or (
                type(constructed) is dict and
                type(constructed.get("enabled")) is list and
                type(constructed.get("disabled")) is list and
                all(type(name) is str for name in constructed["enabled"] + constructed["disabled"])),
                "Compatibility table is invalid")
    return data


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
    for name, expected in entry["sources"].items():
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


def harden_constructed_agent(agent, entry: dict) -> None:
    """Prove the constructed agent enforces Ardur's toolset restriction.

    Runs for every entry that declares the stronger expectations; entries
    without them (the original pin) are untouched.
    """
    constructed = entry.get("constructedToolsets")
    if constructed:
        require(getattr(agent, "enabled_toolsets", None) == constructed["enabled"] and
                getattr(agent, "disabled_toolsets", None) == constructed["disabled"],
                "Constructed toolsets changed")
    callback_name = entry["callbacks"]["setup_mcp_callback"]
    if callback_name != "setup_mcp_callback":
        original = getattr(agent, callback_name, None)
        require(original is None or callable(original), "MCP attach callback is invalid")

        def ardur_guarded_connect(*args, **kwargs):
            server = kwargs.get("server") or kwargs.get("name") or (args[0] if args else None)
            require(getattr(server, "name", server) == "ardur", "MCP server attachment refused")
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
                    require(kwargs.get("enabled_toolsets") in (None, ["mcp-ardur"]), "ACP toolset override refused")
                    require(kwargs.get("disabled_toolsets") in (None, ["hermes-acp"]), "ACP toolset override refused")
                agent = run_agent.AIAgent(
                    base_url=route, api_key=token, provider="custom", api_mode="chat_completions",
                    model=expected_model, max_iterations=max_iterations, run_budget_seconds=run_budget_seconds,
                    max_tokens=max_tokens,
                    enabled_toolsets=["mcp-ardur"], disabled_toolsets=["hermes-acp"],
                    save_trajectories=False, skip_context_files=True, load_soul_identity=True,
                    skip_memory=True, skip_background_review=True, fallback_model=None,
                    checkpoints_enabled=False, quiet_mode=True, platform="acp",
                    session_id=kwargs["session_id"], session_db=self._get_db(),
                )
                agent.session_cwd = kwargs["cwd"]
                agent._print_fn = session._acp_stderr_print
                harden_constructed_agent(agent, entry)
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
