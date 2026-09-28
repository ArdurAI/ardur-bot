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


PIN = "29112bef099274229cadff79cdff7bf7b99c4b77"
SOURCES = {
    "acp_adapter/session.py": "423f9b8b065600607dced5185ce58cd60d2fe450844caf6ce6229c3b7ceeb835",
    "acp_adapter/server.py": "5ebbbda6511a692faeaf8f57e0ad88182bf22c2d818d16c94f1e95516bb7375d",
    "acp_adapter/entry.py": "b70e7b189e36644d60576bc1acdc929ae4bd16c80022d5e2b7a8dec97b24d383",
    "run_agent.py": "5b2e7083680e6c728f2306adc73e5f814c444aaa9ff3e3b840206142c67a7149",
    "pyproject.toml": "c70c8b52f6cc08a4e65f0fc1713c26814fd4f19811bc7e01de645009b2a76600",
    "uv.lock": "383cd8f98ec23dc3fe4cf63759ec73be5a869cc953f068b4e79ec4e8ed00287d",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def check_install(root: Path, home: Path) -> None:
    require(root.is_absolute() and root.is_dir(), "Install root is unavailable")
    require(home.is_absolute() and home.is_dir() and home != root, "Private home is required")
    require(root not in home.parents, "Private home overlaps the install")
    require(not (root / ".env").exists(), "Install has a project dotenv")
    require(not (home / ".env").exists(), "Private home has a dotenv")
    require((root / ".venv/bin/python").resolve() == Path(sys.executable).resolve(), "Interpreter differs from install")
    revision = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True, timeout=5,
    ).stdout.strip()
    require(revision == PIN, "Install revision changed")
    for name, expected in SOURCES.items():
        require(hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, f"Install source changed: {name}")


def check_hooks(session, server, run_agent) -> None:
    make = session.SessionManager._make_agent
    signature = inspect.signature(make)
    require(list(signature.parameters) == [
        "self", "session_id", "cwd", "model", "requested_provider", "base_url", "api_mode"
    ], "Session hook signature changed")
    require(all(signature.parameters[name].kind is inspect.Parameter.KEYWORD_ONLY for name in list(signature.parameters)[1:]), "Session hook is no longer keyword-only")
    source = inspect.getsource(make)
    require('"hermes-acp"' in source and "disabled_toolsets" not in source, "Session hook behavior changed")
    require(list(inspect.signature(session._expand_acp_enabled_toolsets).parameters) == ["toolsets", "mcp_server_names"], "Toolset helper changed")
    require(list(inspect.signature(server.HermesACPAgent.__init__).parameters) == ["self", "session_manager"], "ACP injection changed")
    parameters = inspect.signature(run_agent.AIAgent.__init__).parameters
    require(len(parameters) == 81 and {"base_url", "api_key", "provider", "api_mode", "model", "max_iterations", "enabled_toolsets", "disabled_toolsets", "save_trajectories", "skip_context_files", "skip_memory", "skip_background_review", "run_budget_seconds", "fallback_model"} <= parameters.keys(), "Agent constructor changed")


def main() -> None:
    root = Path(os.environ["ARDUR_HERMES_INSTALL"]).resolve()
    home = Path(os.environ["HERMES_HOME"]).resolve()
    route = os.environ["ARDUR_HERMES_RELAY_URL"]
    model = os.environ["ARDUR_HERMES_MODEL"]
    max_tokens = int(os.environ["ARDUR_HERMES_MAX_TOKENS"])
    token = os.environ.pop("ARDUR_HERMES_PROVIDER_KEY")
    require(route.startswith("http://127.0.0.1:") and route.endswith("/v1"), "Relay must be loopback")
    require(bool(token) and bool(model), "Broker grant and model are required")
    require(1 <= max_tokens <= 65536, "Model output limit is invalid")
    require(os.environ.get("PYTHONDONTWRITEBYTECODE") == "1", "Bytecode writes are forbidden")
    check_install(root, home)
    sys.path.insert(0, str(root))
    with contextlib.redirect_stdout(sys.stderr):
        import acp
        from acp_adapter import entry, server, session
        import run_agent

        check_hooks(session, server, run_agent)
        entry._setup_logging()

        class ArdurSessionManager(session.SessionManager):
            def _make_agent(self, *, session_id, cwd, model=None, requested_provider=None, base_url=None, api_mode=None):
                require(model in (None, expected_model), "ACP model override refused")
                require(requested_provider in (None, "custom"), "ACP provider override refused")
                require(base_url in (None, route), "ACP route override refused")
                require(api_mode in (None, "chat_completions"), "ACP API override refused")
                agent = run_agent.AIAgent(
                    base_url=route, api_key=token, provider="custom", api_mode="chat_completions",
                    model=expected_model, max_iterations=16, run_budget_seconds=180,
                    max_tokens=max_tokens,
                    enabled_toolsets=["mcp-ardur"], disabled_toolsets=["hermes-acp"],
                    save_trajectories=False, skip_context_files=True, load_soul_identity=True,
                    skip_memory=True, skip_background_review=True, fallback_model=None,
                    checkpoints_enabled=False, quiet_mode=True, platform="acp",
                    session_id=session_id, session_db=self._get_db(),
                )
                agent.session_cwd = cwd
                agent._print_fn = session._acp_stderr_print
                return agent

        class ArdurACPAgent(server.HermesACPAgent):
            def __init__(self, session_manager):
                super().__init__(session_manager=session_manager)
                self._session_created = False
                self._prompt_started = False

            async def new_session(self, cwd, mcp_servers=None, **kwargs):
                require(not self._session_created, "Only one ACP session is allowed")
                require(len(mcp_servers or []) == 1 and mcp_servers[0].name == "ardur", "Only the Ardur MCP server is allowed")
                self._session_created = True
                return await super().new_session(cwd, mcp_servers=mcp_servers, **kwargs)

            async def prompt(self, prompt, session_id, **kwargs):
                require(self._session_created and not self._prompt_started, "Only one ACP prompt is allowed")
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
