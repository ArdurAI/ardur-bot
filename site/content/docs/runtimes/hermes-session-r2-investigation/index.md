---
title: "Session-start follow-up — 2026-10-03"
description: "Part of #118. This work does not close the issue."
source_path: "docs/runtimes/hermes-session-r2-investigation.md"
---

> [Source: docs/runtimes/hermes-session-r2-investigation.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/docs/runtimes/hermes-session-r2-investigation.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

Part of #118. This work does not close the issue.

## Evidence boundary

The designated pinned 0.21.0 interpreter could not start under the host sandbox.
The launch ended with exit 71 and “sandbox_apply: Operation not permitted”.
No confinement was removed to get a successful launch. No database, private
runtime home, external provider, or existing process was accessed.

The fallback reads the pinned ACP adapter and runs deterministic Ardur fixtures.
The 56-tool fixture is synthetic. It is not a copy of the failed run’s tool
catalog, and its result is not proof that the development bot now answers.

## A: connected tool-name mismatch

Pinned commit `29112bef099274229cadff79cdff7bf7b99c4b77`:
`tools/mcp_tool.py` (`sanitize_mcp_name_component`,
`mcp_prefixed_tool_name`) replaces every character outside
`[A-Za-z0-9_]` in each name component with an underscore.
Ardur’s broker already does this. Its runtime’s profile allow-list and progress
title check instead append the original tool name unchanged.

A synthetic connected tool named `mcp__fixture-app__read` is registered as
`mcp__ardur__mcp__fixture_app__read`, while Ardur expects
`mcp__ardur__mcp__fixture-app__read`.

Pinned `acp_adapter/server.py:new_session` logs “New session” before returning.
Ardur’s owned launcher then runs `check_catalog`, which raises
`RuntimeError: Constructed tool catalog changed` on this mismatch. An empty
catalog passes. The fixture uses the actual Ardur stdio MCP bridge and reproduces
the session/new -32603 refusal for 56 synthetic tools, with one affected name.

This is a confirmed source-level defect and reproduces the reported phase and
populated-versus-empty split. The actual failed run’s catalog and traceback were
not available here, so that final link remains unverified. Do not infer it from
the number of tools or child-output lines.

## B: translated streaming admission

Pinned `agent/chat_completion_helpers.py`’s streaming `_open_stream` adds
`stream_options: { include_usage: true }` for non-native-Gemini endpoints.
The managed relay is such an endpoint.

Ardur’s `admittedTranslatedBody` rejects any object-valued `stream_options`
before calling its shared admission validator. A tools-free summary request with
the exact pinned streaming option therefore raises
`Provider request is outside this run's grant.` before any provider call.
The same main-turn request fails too. Existing translated fixtures omit the
option and miss this incompatibility.

The relay then catches the exception without retaining a reason. Separate
fixtures show that profile-acknowledgment, grant and byte-limit failures all
collapse into the same callback with no arguments.

These deterministic reproductions establish the defects, not an upstream
provider refusal or a live summary run’s captured exception.

## Product and safety

The operator needs the pinned bot to start and a failure sentence that names the
safe cause. The builder needs a bounded diagnostic without request bodies,
headers, credentials, or private ACP data. The fixes must preserve the pin,
exact tool consent, collision refusal, profile acknowledgment, output limits,
and all per-action approvals on every applicable surface.

## Changes and verification

The runtime now shares the broker's pinned MCP naming helper for its exact
profile allow-list and progress gate. Name collisions are refused before launch.
A pin-bound test forces this rule to be requalified if the Hermes pin changes.

The translated route passes the supplied streaming option through the common
strict validator rather than rejecting every object or overwriting it. Main and
summary fixtures now complete with the pinned usage option; unsupported options
still stop before provider access.

The relay projects exceptions to a fixed safe reason and validated HTTP status,
records that projection through the existing redaction helper, and passes it to
the active run. Message-only remote callbacks retain the same fixed facts.
Profile, grant, request/response limit, provider authentication and unknown
provider failures have shared categories. The exact owned catalog-check failure
has a startup category; unrelated ACP errors keep the generic category.

Local deterministic verification passed 530 tests in the broad run. Four existing
local launch tests failed at initialize with sandbox exit 71; two opt-in tests
were skipped. The missing generated client was generated from the schema without
a database connection. Host-runtime, adapters, API and web source type checks
passed. The Python launcher suite passed 41 tests. Catalog and failure-copy
checks passed 191 tests, covering all nine web locales and both non-English
mobile locales.

The synthetic ACP fixture completes after the fix. **The real pinned Hermes did
not answer in a fixture in this environment.** Its confined interpreter could not
start. The actual failed 56-tool catalog and live brief exception still need
redacted evidence. #118 stays open; CI screenshots and unit results are not human
or real-runtime acceptance.
