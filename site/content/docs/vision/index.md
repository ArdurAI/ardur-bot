---
title: "Vision"
description: "Ardur Bot exists so that people can own a team of AI bots that keep working, on models and"
source_path: "VISION.md"
---

> [Source: VISION.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/VISION.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

Ardur Bot exists so that people can own a team of AI bots that keep working, on models and
computers they choose, without surrendering their subscriptions, their data, or their judgment.

It is a fork of Rakazo, and it keeps Rakazo's core: a bot is a continuing identity with one
visible conversation, durable memory, routines, and a computer. What Ardur Bot adds is a
promise about **who does the work and where**: every bot is pinned to a provider, model and
effort level that the owner chose, using the owner's own subscriptions and keys, and that pin
never silently changes.

## Who uses it, and what "better" means to each of them

Every change should be able to answer: which of these people does it help, on which task, and
how would they notice?

### The operator (non-technical)

Runs a team, a practice, a shop, or a household. Pays for ChatGPT or Claude already. Has never
opened a terminal and does not want to.

- Wants: install in minutes, sign in with the subscription she already has, describe a bot's
  job in plain words, watch it work, approve before anything is sent, and see a plain summary of
  what happened.
- Fears: words like provider, model, effort, token, Docker; raw error text; anything that looks
  like a config file.
- Typical tasks: email and calendar triage, weekly reports, form filling, research summaries,
  reminders that actually do the thing.
- "Better" looks like: sensible defaults that work the first time; every error is one sentence
  plus one button; progress she can see; undo.

### The builder (technical)

Developer or ops engineer. Wants control and no magic.

- Wants: choose provider, model and effort per bot; MCP servers and connectors; computers on
  Docker, Podman or Kubernetes; cron routines; logs; cost per bot; keyboard shortcuts; export
  and import of bot configurations; a self-hosted server with the desktop app pointed at it.
- Fears: hidden fallbacks, lock-in, opaque failures, settings spread across five places.
- Typical tasks: a review bot on the strongest model at the highest effort, a CI watcher, a
  runbook executor, PR triage, log analysis.
- "Better" looks like: everything reachable from Settings, everything inspectable, nothing
  happening that the UI did not show.

### The researcher (research-grade)

Analyst, scientist, or writer doing long, rigorous work.

- Wants: several bots in parallel on different models, compared side by side; sources and
  citations kept; memory that can be read and edited; exports; provenance (which model and
  version produced this, at what effort); routines that run for weeks.
- Fears: invented citations, silent model substitution, lost context, results that cannot be
  reproduced.
- Typical tasks: literature sweeps, multi-step analysis, experiment tracking, drafting with
  sources.
- "Better" looks like: pins that fail closed with a clear message rather than quietly using a
  different model; the model and effort visible at a glance; everything a bot read and wrote
  available afterwards.

### The team lead

Shares bots across a space with a few colleagues.

- Wants: approval policies, an audit trail, cost by bot and provider, simple roles.
- "Better" looks like: one place to see what every bot did today and what it cost.

### The local-first user

Runs Ollama and keeps data at home.

- Wants: local models as a first-class choice, computers on the host machine, and a clear
  indicator of what leaves the machine and what does not.
- "Better" looks like: no cloud requirement for the core loop, and honesty about the rest.

## Principles that follow

1. **Defaults that work the first time.** A new user with one subscription should reach a
   working bot without choosing anything technical. When a choice is unavoidable, recommend one.
2. **Simple surface, deep settings one click away.** The chat shows the bot, the work, and
   genuine requests for help. Everything else lives in Settings, organised by what the user is
   trying to do, not by how the code is organised.
3. **Every error is a sentence and an action.** Never show raw JSON or a stack trace to the
   user. Say what happened, what it means, and offer the fix.
4. **Pins are promises.** A bot's provider, model, effort, runtime and computer are what the
   owner set. If they cannot be honoured, the bot stops and says why. No silent fallback.
5. **Visible but quiet.** The model and effort in use are always one glance away, and never in
   the way.
6. **Fast, and it feels fast.** Feedback within a tenth of a second, streaming output, no
   layout jumps, motion that explains a change and respects reduce-motion.
7. **Same product everywhere.** Windows, macOS, Linux, web and mobile expose the same bots and
   the same settings, or say plainly what a platform cannot do.
8. **Your subscriptions, honestly.** Use each provider the way its terms allow. Never store or
   route a subscription token the vendor has not permitted a third-party app to use.
9. **Show the work.** Every run leaves a record a person can read: what the bot read, called,
   changed and spent.

## Before every commit

Answer these in the commit message or the pull request; if the answers are "nobody" and
"nothing", the change probably does not belong.

- Which persona benefits, on which task?
- What did the user see before, and what do they see now?
- Did any error get turned from text into a sentence plus an action?
- Does it keep the promise of the pin (no new fallback)?
- Performance: did anything get slower, heavier, or janky?
- Does it work on all three desktop platforms, or say why not?
- Is there a test for the new behaviour?

## Current decisions

This file records current product truth. Git history keeps what it replaced.

- Rakazo's mechanics (bots, groups, routines, computers, approvals, memory) are kept and
  credited; see NOTICE and docs/decisions/ADR-001-fork-and-rename.md.
- Claude subscriptions are used only through the user's own unmodified `claude` binary. The
  inherited Claude.ai OAuth login is removed from Ardur Bot builds.
- Work lands on `dev`; `main` moves only after a human has verified a build.
