---
title: "Status"
description: "What works now, what is still in progress, and what is planned, each linked to the repo file that backs it."
eyebrow: "Honest status"
---

{{< pill "progress" >}}Pre-alpha{{< /pill >}}

Everything lands on the `dev` branch; `main` moves only after a human has verified a build. The
release workflow produces unsigned desktop previews. This page is generated from the docs and
[CHANGELOG]({{< repo-link "CHANGELOG.md" >}}), not from marketing copy. Every line below links to
the repo file it comes from.

## Works today

- Persistent bots with their own conversation, memory, routines and history, plus group chats and
  delegation between bots and short-lived subagents — [README]({{< repo-link "README.md#what-you-get-today" >}}).
- A provider, model and thinking level per bot, with OpenRouter, OpenAI Codex, Anthropic, OpenAI,
  Google, Vercel AI Gateway, and any OpenAI-compatible server (Kimi, Z.ai, Ollama, LM Studio,
  llama.cpp) — [README]({{< repo-link "README.md#what-you-get-today" >}}).
- Computers on this machine, Docker, Podman, Kubernetes or SSH, plus E2B, Daytona or Box, with a
  browser, terminal, files and a graphical desktop — [Self-hosting: where bots run]({{< repo-link "docs/self-host.md#where-bots-run" >}}).
- Connectors through MCP servers, OpenAPI documents, Composio and Pipedream Connect, with
  approvals before consequential actions — [README]({{< repo-link "README.md#what-you-get-today" >}}).
- Web, Electron desktop and Expo mobile clients of the same API — [README]({{< repo-link "README.md#what-you-get-today" >}}).
- Board, for dependent work an operator can create, assign and review — [Board]({{< repo-link "docs/board.md" >}}).
- Per-bot memory backed by a git repository or a semantic provider — [Memory: git repository]({{< repo-link "docs/memory/git-repository.md" >}}).
- Import of existing instructions, memories, skills and MCP server definitions from the host
  computer — [Import local tool data]({{< repo-link "docs/local-import.md" >}}).

## In progress and known limitations

- Desktop previews are **unsigned**; macOS builds are also **not notarized**, and updates are
  download-only on every OS — [Desktop pre-releases]({{< repo-link "docs/desktop-release.md" >}}).
- No signed installer and no published Homebrew tap yet; the cask template exists but has not been
  published — [Homebrew tap handoff]({{< repo-link "docs/desktop-release.md#homebrew-tap-handoff" >}}).
- A tag push currently stops at the performance-evidence gate because no physical evidence runner
  exists yet; publication needs a manual dispatch with an explicit waiver reason —
  [Evidence index]({{< repo-link "docs/performance.md#evidence-index" >}}).
- Fleet's computer-moving lifecycle covers fake and real desktop workspaces; Docker, Podman, SSH
  and Kubernetes lifecycle moves remain open — [Fleet P1]({{< repo-link "docs/fleet.md" >}}).
- Learning reviews are disabled by default and, when enabled, can only produce proposals — they
  cannot apply a change, change a pin or an approval default, or call a tool —
  [Learning reviews]({{< repo-link "docs/learning.md" >}}).
- No public mobile app store listing yet; the mobile client points at a self-hosted or
  desktop-hosted server — [Mobile builds and store releases]({{< repo-link "docs/mobile-release.md" >}}).
- The Claude subscription path only uses the owner's own unmodified `claude` binary; the inherited
  Claude.ai OAuth login is being removed from {{< product >}} builds —
  [ADR-002: pins are promises]({{< repo-link "docs/decisions/ADR-002-runtime-pins.md" >}}).

## Roadmap

- Subscription-honest providers: Claude Pro/Max through the unmodified `claude` CLI, Codex through
  OpenAI's documented integration, Kimi and Z.ai coding plans, Gemini with an API key, and Ollama
  as a first-class choice — [README]({{< repo-link "README.md#where-it-is-going" >}}).
- Computers on Podman and kind/Kubernetes — [README]({{< repo-link "README.md#where-it-is-going" >}}).
- A published Homebrew tap and, later, signed and notarized downloads —
  [README]({{< repo-link "README.md#where-it-is-going" >}}).
- A fast, smooth UI on Windows, macOS and Linux — [README]({{< repo-link "README.md#where-it-is-going" >}}).

Roadmap discussion and open questions live in
[GitHub Discussions]({{ .Site.Params.repoURL }}/discussions), not on this page.

## Changelog

The [CHANGELOG]({{< repo-link "CHANGELOG.md" >}}) records the fork itself: forked from Rakazo
commit `59d4f0c2` (2026-09-23) under Apache-2.0, project-wide rename to {{< product >}}, CI trimmed
to advisory checks, and the ADR log added under `docs/decisions/`.
