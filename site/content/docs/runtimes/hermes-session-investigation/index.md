---
title: "Pinned session-start investigation — 2026-10-02"
description: "Part of #118. The original failed run remains unconfirmed."
source_path: "docs/runtimes/hermes-session-investigation.md"
---

> [Source: docs/runtimes/hermes-session-investigation.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/docs/runtimes/hermes-session-investigation.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

Part of #118. The original failed run remains unconfirmed.

## What the pinned source accepts

Release 0.21.0 at commit `29112bef099274229cadff79cdff7bf7b99c4b77`
accepts Ardur’s current session request: an absolute workspace cwd and a stdio
MCP server with command, argv, and environment as a list of name/value strings.
Do not replace that list with a mapping.

The real launcher and fake-provider lane passed both existing scenarios,
including an Ardur tool roundtrip, with no request rewrite. Database connections
were prohibited by an audit hook before loading the pinned source. The temporary
home was inside the investigation worktree. The launcher and install were not
modified. This is not unmodified database-persistence acceptance.

## Confirmed refusal

A synthetic model with a context window of 32,768 is rejected during construction.
At 65,536 the same request opens a session. The pinned source’s floor is exactly
64,000, not 65,536. Its ACP response is code -32603, message “Internal error”,
and a private `data.details` string explaining the context floor.

The client previously read `data.message` but not `data.details`. It now uses the
latter for private classification only. Only the confirmed session/new error
code and exact floor signature select the fixed recovery sentence; unknown
errors, another floor, or another code retain the generic session-start message.
No response data is added to logs or returned to the conversation.

A logging-only wrapper printed the exception from the original session handler;
the SDK did not print a traceback to stderr on its own in this reproduction.
The stack led through the launcher’s new_session and _make_agent, the pinned
ACP server’s new_session and SessionManager.create_session, the constructor,
and agent_init.py’s minimum-context ValueError.

This proves one failure and the lost private diagnostic field, not that the
original nine child-output lines were a traceback or that their cause was
the same. The original run’s admitted model window and detailed process output
are still needed to establish that link. A draft must not close #118 on this
evidence alone.

## Pin and platform boundary

No source pin, compatibility entry, guard, deadline, model, or effort is changed.
The message is shared by web, Electron, and mobile and appears only on failure,
with the existing model-settings recovery action. Runtime startup work is
unchanged; no network service or additional provider call is added.

A future pin change needs a reviewed entry in
`packages/host-runtime/python/hermes_compat.json`, matching source hashes,
the TypeScript and Python compatibility guards, and the tested-version evidence
in `docs/decisions/ADR-003-hermes-runtime.md`. It must pass offline guard and
constructed-authority tests and separate real-install fake-provider lanes on
macOS and Linux. Windows stays unavailable until its own native acceptance
passes. A newer revision is not a fix without that qualification.
