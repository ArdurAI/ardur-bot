---
title: "Support"
description: "How to get help, report a bug, or report a security issue."
eyebrow: "Support"
---

## Bugs and feature requests

Open an [issue]({{ .Site.Params.repoURL }}/issues) in the public repository. Include what you
expected, what happened, and the version you ran (`ardur-bot --version` for a packaged build).

## Questions, ideas, roadmap

Use [GitHub Discussions]({{ .Site.Params.repoURL }}/discussions).

## Security reports

Email **{{ .Site.Params.securityEmail }}**. Do not open a public issue for a security bug. Include
steps to reproduce, the impact, and whether the issue is already public. See
[SECURITY.md]({{< repo-link "SECURITY.md" >}}) for the full scope: anything that lets a bot, a
connector, a prompt, or another user escape the boundaries of the computer it runs on.

## Self-hosting help

Start with the [self-hosting guide]({{< repo-link "docs/self-host.md" >}}). Common self-hosting
problems — secrets, providers, upgrades, restricted networks — already have a dedicated page
under [Docs]({{< ref "/docs/" >}}).

## Other contact

General product questions: **{{ .Site.Params.supportEmail }}**. Never send passwords, API keys,
access tokens, or other secrets by email.
