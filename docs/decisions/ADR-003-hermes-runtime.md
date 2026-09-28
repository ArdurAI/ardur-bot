# ADR-003: Hermes as an optional bot runtime

Date: 2026-09-27. Status: Experimental implementation; native acceptance pending.

## Decision

Expose Hermes in the shared runtime picker and keep Ardur as the authority for
connections, model pins, tools, permissions and usage. A bot selects an existing
direct Chat Completions connection, its model and effort, then may adjust only a
versioned call count and time limit. The worker brokers provider traffic; the
paired host launches a pinned installation in a fresh synthetic home with only
the Ardur MCP bridge. Stop and lease loss revoke the per-turn grant.

The first qualified provider set is `openai-compatible` and Ollama. The default
limits are 16 calls and 180 seconds, with strict bounds. Host execution has native
owner authority. macOS and Linux require separate pinned-install acceptance;
Windows is unavailable. History is labeled quoted context. Effort remains
requested-only unless provider confirmation is qualified. Usage without a known
purpose or measurement remains unknown. A release need not wait for an upstream
configuration change because the owned launcher enforces the boundary.

## Alternatives and consequences

Copying connection credentials, skills, plugins or MCP definitions into Hermes
would create a second source of permissions and state, so the existing Ardur bridge
is reused. Native provider-role replay and broader protocol translation could
improve fidelity, but neither is qualified for this stage. A generic runtime
plugin marketplace would expand the execution and supply-chain boundary beyond
the pinned install. The native process can access the host outside Ardur tool
callbacks; users must understand that authority before selecting it.

Pins and versioned limits are immutable within an admitted run. An unsupported
connection, stale host protocol or missing installation fails closed. Broker
receipts remain the source for provider usage, including conservative reservations
when usage is unknown. Separate Ardur/Hermes benchmark evidence is needed before
making cost or performance claims. See [runtime behavior](../runtimes/hermes.md).
