"""Bounded validation for the owned Hermes configuration profile."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise RuntimeError(reason)


def pairs_unique(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate configuration property")
        result[key] = value
    return result


def owned_json(path: Path, limit: int, private: bool = True) -> dict:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, "Configuration file is invalid")
        require(not private or (info.st_uid == os.getuid() and info.st_mode & 0o077 == 0),
                "Configuration file is not private")
        data = os.read(fd, limit + 1)
        require(len(data) <= limit, "Configuration file is too large")
        value = json.loads(data.decode("utf-8"), object_pairs_hook=pairs_unique)
        require(type(value) is dict, "Configuration object is required")
        return value
    finally:
        os.close(fd)


def keys(value: object, expected: set[str]) -> None:
    require(type(value) is dict and set(value) == expected, "Configuration shape is invalid")


def integer(value: object, lower: int, upper: int, step: int = 1) -> None:
    require(type(value) is int and lower <= value <= upper and value % step == 0, "Configuration limit is invalid")


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def generated(settings: dict, model: dict) -> dict:
    native = ["web", "terminal", "process", "files", "browser", "vision", "skills", "todo",
              "memory", "session_search", "execute_code", "delegate_task", "cronjob"]
    model_id = model["id"]
    return {
        "model": {"default": model_id, "provider": "custom", "context_length": model["contextWindow"],
                  "supports_vision": model["acceptsImages"]},
        "custom_providers": [],
        "model_overrides": {"custom:ardur": {model_id: {
            "context_window": model["contextWindow"], "supports_reasoning": model["reasoning"],
            "supports_vision": model["acceptsImages"], "supports_tools": True,
        }}} if model["reasoning"] or model["acceptsImages"] else {},
        "fallback_providers": [], "toolsets": [],
        "agent": {"disabled_toolsets": native,
                  "reasoning_effort": "none" if model["thinkingLevel"] == "off" else model["thinkingLevel"],
                  "coding_context": "off", "environment_probe": False,
                  "api_max_retries": settings["harness"]["agent"]["api_max_retries"],
                  "max_turns": settings["limits"]["maxProviderRequests"],
                  "run_budget_seconds": settings["limits"]["timeoutMs"] // 1000},
        "context": {"engine": "compressor"},
        "context_file_max_chars": settings["context"]["maxInputBytes"],
        "compression": {"enabled": False, "micro_compact": False, "proactive_prune_tokens": 0,
                        "idle_compact_after_seconds": 0, "codex_app_server_auto": "off"},
        "auxiliary": {"background_review": {"enabled": False}, "title_generation": {"enabled": False}},
        "memory": {"memory_enabled": False, "user_profile_enabled": False},
        "skills": {"project_discovery": False, "external_dirs": [], "inline_shell": False},
        "delegation": {"max_iterations": 0}, "cron": {"allow_agent_scheduling": False},
        "hooks": {}, "hooks_auto_accept": False, "plugins": {"enabled": []},
        "telemetry": {"shared_metrics": {"enabled": False}},
        "security": {"allow_lazy_installs": False},
        "tools": {"tool_search": {"enabled": "off"}}, "mcp_servers": {},
    }


def validate(home: Path, env: dict[str, str]) -> dict:
    artifact = owned_json(Path(__file__).with_name("runtime_config_profile.json"), 65536, False)
    keys(artifact, {"format", "profile", "artifactVersion", "sourceRevision", "maxTextBytes",
                    "maxDepth", "maxMembers", "fields", "defaults", "strictObjects", "jsonSchema"})
    require(artifact["format"] == 1 and artifact["profile"] == "hermes-ardur-v2" and
            artifact["artifactVersion"] == 1 and
            artifact["sourceRevision"] == "29112bef099274229cadff79cdff7bf7b99c4b77" and
            artifact["strictObjects"] is True, "Configuration schema changed")
    envelope = owned_json(home / "runtime-manifest.json", 65536)
    keys(envelope, {"runtimeKind", "runtimeConfig", "runtimeConfigHash", "effectiveRuntimeConfig",
                    "effectiveRuntimeConfigHash"})
    manifest = envelope["effectiveRuntimeConfig"]
    keys(manifest, {"format", "profile", "runtimeKind", "settings", "model", "generatedConfig",
                    "launcher", "bindings"})
    keys(manifest["profile"], {"format", "profile", "sourceRevision", "artifactVersion"})
    require(manifest["profile"] == {key: artifact[key] for key in
            ("format", "profile", "sourceRevision", "artifactVersion")}, "Configuration profile changed")
    require(type(manifest["format"]) is int and manifest["format"] == 1 and
            manifest["runtimeKind"] == envelope["runtimeKind"] == "hermes", "Runtime profile changed")
    settings = envelope["runtimeConfig"]
    keys(settings, {"version", "runtimeKind", "limits", "context", "harness"})
    require(type(settings["version"]) is int and settings["version"] == 2 and
            settings["runtimeKind"] == "hermes" and settings == manifest["settings"], "Settings changed")
    keys(settings["limits"], {"maxProviderRequests", "timeoutMs"})
    keys(settings["context"], {"maxInputBytes", "overflow"})
    keys(settings["harness"], {"agent"})
    keys(settings["harness"]["agent"], {"api_max_retries"})
    for path, value in (("limits.maxProviderRequests", settings["limits"]["maxProviderRequests"]),
                        ("limits.timeoutMs", settings["limits"]["timeoutMs"]),
                        ("context.maxInputBytes", settings["context"]["maxInputBytes"]),
                        ("harness.agent.api_max_retries", settings["harness"]["agent"]["api_max_retries"])):
        field = artifact["fields"][path]
        integer(value, field["min"], field["max"], field["step"])
    require(settings["context"]["overflow"] in artifact["fields"]["context.overflow"]["values"],
            "Context overflow mode is invalid")
    model = manifest["model"]
    keys(model, {"id", "contextWindow", "maxTokens", "reasoning", "acceptsImages", "thinkingLevel"})
    require(type(model["id"]) is str and re.fullmatch(r"[\w./:-]{1,200}", model["id"], re.ASCII),
            "Model identity is invalid")
    integer(model["contextWindow"], 1, 2_000_000)
    integer(model["maxTokens"], 1, 65536)
    require(type(model["reasoning"]) is bool and type(model["acceptsImages"]) is bool and
            model["thinkingLevel"] in ("off", "minimal", "low", "medium", "high", "xhigh", "max"),
            "Model capability is invalid")
    launcher = manifest["launcher"]
    keys(launcher, {"model", "maxIterations", "runBudgetSeconds", "contextFileMaxChars", "apiMaxRetries"})
    require(launcher == {"model": model["id"],
                         "maxIterations": settings["limits"]["maxProviderRequests"],
                         "runBudgetSeconds": settings["limits"]["timeoutMs"] // 1000,
                         "contextFileMaxChars": settings["context"]["maxInputBytes"],
                         "apiMaxRetries": settings["harness"]["agent"]["api_max_retries"]},
            "Launcher parameters changed")
    require(manifest["generatedConfig"] == generated(settings, model) ==
            owned_json(home / "config.yaml", 65536), "Generated configuration changed")
    require(manifest["bindings"] == {"credentials": "broker-grant", "tools": "ardur-catalog",
            "approvals": "ardur-policy", "paths": "ephemeral-owned-home", "network": "managed-relay"},
            "Managed binding changed")
    settings_hash = hashlib.sha256(("ardur:runtime-config:v2\n" + canonical(settings)).encode()).hexdigest()
    effective_hash = hashlib.sha256(("ardur:effective-runtime-config:v1\n" + canonical(manifest)).encode()).hexdigest()
    require(envelope["runtimeConfigHash"] == settings_hash and
            envelope["effectiveRuntimeConfigHash"] == env.get("ARDUR_HERMES_EXPECTED_HASH") == effective_hash,
            "Configuration identity changed")
    require(env.get("ARDUR_HERMES_PROFILE") == artifact["profile"] and
            env.get("ARDUR_HERMES_MODEL") == model["id"] and
            env.get("ARDUR_HERMES_MAX_TOKENS") == str(model["maxTokens"]) and
            env.get("ARDUR_HERMES_MAX_ITERATIONS") == str(launcher["maxIterations"]) and
            env.get("ARDUR_HERMES_RUN_BUDGET_SECONDS") == str(launcher["runBudgetSeconds"]) and
            env.get("HERMES_DISABLE_LAZY_INSTALLS") == "1" and env.get("PATH") == "/usr/bin:/bin",
            "Launcher environment changed")
    allowed = json.loads(env.get("ARDUR_HERMES_ALLOWED_TOOLS", "null"))
    require(type(allowed) is list and len(allowed) <= 256 and
            all(type(name) is str and re.fullmatch(r"mcp__ardur__[^\x00-\x1f\x7f]{1,160}", name)
                for name in allowed) and allowed == sorted(set(allowed)), "Tool catalog is invalid")
    return {"manifest": manifest, "hash": effective_hash, "allowedTools": allowed}


def check_constructed(agent: object, manifest: dict) -> None:
    launcher = manifest["launcher"]
    model = manifest["model"]
    require(getattr(agent, "model", None) == model["id"] and
            getattr(agent, "max_iterations", None) == launcher["maxIterations"] and
            getattr(agent, "run_budget_seconds", None) == launcher["runBudgetSeconds"] and
            getattr(agent, "_api_max_retries", None) == launcher["apiMaxRetries"],
            "Constructed limits changed")
    require(getattr(agent, "compression_enabled", None) is False and
            getattr(agent, "_memory_enabled", None) is False and
            getattr(agent, "_user_profile_enabled", None) is False and
            getattr(agent, "skip_background_review", None) is True and
            getattr(agent, "_skip_mcp_refresh", None) is True,
            "Constructed native activity is unavailable")
    require(getattr(agent, "provider", None) == "custom" and
            getattr(agent, "api_mode", None) == "chat_completions" and
            getattr(agent, "enabled_toolsets", None) == ["mcp-ardur"],
            "Constructed route or toolsets changed")


def check_catalog(agent: object, allowed: list[str]) -> None:
    tools = getattr(agent, "tools", None)
    require(type(tools) is list and all(type(item) is dict and
            type(item.get("function")) is dict and type(item["function"].get("name")) is str
            for item in tools), "Constructed tool catalog is invalid")
    actual = sorted(item["function"]["name"] for item in tools)
    require(actual == allowed, "Constructed tool catalog changed")


def acknowledge(home: Path, configuration_hash: str, session_id: str) -> None:
    require(type(session_id) is str and 0 < len(session_id) <= 160, "Session identity is invalid")
    path = home / "runtime-ack.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"profile": "hermes-ardur-v2", "configurationHash": configuration_hash,
                       "sessionId": session_id}, stream, separators=(",", ":"))
    except BaseException:
        os.unlink(path)
        raise
