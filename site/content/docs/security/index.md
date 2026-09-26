---
title: "Security"
description: "Email **security@ardur.ai**. Do not open public GitHub issues for security bugs."
source_path: "SECURITY.md"
---

> [Source: SECURITY.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/SECURITY.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

## Reporting vulnerabilities

Email **security@ardur.ai**. Do not open public GitHub issues for security bugs.

Please include:

- Steps to reproduce
- Impact (what an attacker could do)
- Whether the issue is already public

We will acknowledge your report and work on a fix. Please do not file a public issue for
unfixed vulnerabilities.

## Other contact

- General questions: GitHub Discussions
- Support: **support@ardur.ai**

## Scope

Ardur Bot runs bots that use browsers, terminals and files on computers you control, and
connects to model providers with your own subscriptions and keys. Anything that lets a bot,
a connector, a prompt, or another user escape those boundaries is in scope: authentication,
secret handling, sandbox isolation, host commands, and integrations.
