# Pinned Hermes provider request audit

Source revision: `29112bef099274229cadff79cdff7bf7b99c4b77`.
Checked on 2026-10-03. This is a source-shaped, offline compatibility audit,
not a capture of an installed runtime's request or acceptance of that runtime.

## Custom GLM route

The launcher constructs `AIAgent` with provider `custom`, a loopback relay,
the pinned model and an explicit output cap. The registered custom provider
profile is selected before the legacy flag path.

| Field | Main turn and brief-maintenance summary |
| --- | --- |
| `model` | Launcher-pinned model; GLM uses `glm-5.3`. |
| `messages` | Prepared system/user/history messages. Ardur supplies instructions and quoted history through SOUL.md. |
| `tools` | Selected tool definitions for main; absent for brief maintenance. |
| `max_tokens` | Explicit launcher cap takes priority over the custom profile's default. GLM does not select `max_completion_tokens`. |
| `stream` | True on the main streaming path, also used by the independent brief-maintenance turn. |
| `stream_options` | `include_usage: true` added by `_open_stream`. |
| `reasoning_effort` | Custom profile emits it only when `reasoning_config` requests it. The launcher does not supply that argument. Ardur's translated provider layer uses the pinned effort independently. |
| `reasoning` | Not emitted: the loopback URL fails `_supports_reasoning_extra_body`, and the custom profile uses top-level effort instead. High effort in generated config does not enable this gate. |
| `temperature` | Absent unless the profile or caller supplies it; no custom fixed value is supplied here. |
| `top_p`, `tool_choice`, `parallel_tool_calls` | Absent from this builder with the launcher's arguments. |
| `user`, `seed`, `n`, `stop`, `metadata` | Not supplied by this route. |
| `extra_body` | No custom additions on the generic loopback route. Ollama-specific options do not follow merely from a loopback hostname. |
| `timeout` | Client option, not a JSON request-body field. |

The source path is `agent/chat_completion_helpers.py:build_api_kwargs` →
`agent/transports/chat_completions.py:_build_kwargs_from_profile` →
`plugins/model-providers/custom/__init__.py:CustomProfile` →
`agent/chat_completion_helpers.py:_open_stream`.
The output-key choice and reasoning gate are in `run_agent.py`.
Ardur's constructor arguments are in `python/hermes_launcher.py`, not the
native ACP constructor. The constructor retains an explicit output cap in
`agent/agent_init.py`.

The independent brief-maintenance operation is a new ordinary conversation
with no tools. It is not Hermes's internal iteration-limit summary. That
internal summary builds a non-streaming request separately, also retains an
explicit cap, and does not enable the reasoning extra-body gate on loopback.

## Admission evidence

The offline main fixture uses 56 fake granted tools; the brief fixture uses
none. Both use a one-million-token context window, an explicit cap and the
high pinned effort. Both pass the existing translated broker before any
admission repair. Their fake provider receives the granted cap and high
effort. This rules out blanket rejection of this source-shaped body; it
does not explain the reported installed-runtime failure.

Existing admission also checks the exact model, message shape, tool consent,
output cap, required context, active grant, byte limits and durable request
reservation. A rejected reservation and a missing required context currently
share the same generic grant refusal as a bad request field. The incident's
generic reason alone cannot distinguish these causes.

Do not admit a flattened reasoning object or raise the cap on this evidence.
Capture only a fixed refusal category from the failing run before selecting
an admission repair. Never capture request bodies, values or headers.
