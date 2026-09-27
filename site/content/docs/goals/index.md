---
title: "Team goals"
description: "A team goal gives a group coordinator a bounded period to organize work in the shared room. The group needs a coordinator and at least two members. The deployment owner starts a…"
source_path: "docs/goals.md"
---

> [Source: docs/goals.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/docs/goals.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

A team goal gives a group coordinator a bounded period to organize work in the shared room. The group needs a coordinator and at least two members. The deployment owner starts a goal with an objective, optional completion conditions, a deadline, and a token limit. One active goal is allowed per group.

The coordinator can use `assign` to give separate task cards to several seated members during one turn. Each assignment is admitted under the same delegation root. A worker's final reply appears in the room under that worker's name. A completed, failed, or cancelled assignment wakes the coordinator once; if the coordinator is already active, its run receives steering. Other members' replies are labelled by name in each bot's context.

## Envelope

| Limit | Default | M1 behavior |
| --- | ---: | --- |
| Total tokens | 600,000 | Shared root limit across the goal's delegations |
| Deadline | Eight hours from start | Shared root deadline |
| Tokens per worker | 30,000 | Maximum for one room assignment |
| Concurrent assignments | Seated member count | Shared root admission limit |
| Descendants | 60 | Shared root admission limit |
| Depth | 1 | Workers cannot delegate further |
| Hops | 6 | Shared root hop limit |

The owner may set the total token limit, deadline, per-worker limit, concurrency, and descendant limit at start. The deadline must be in the future and within seven days. Stopping the goal requests cancellation of its root task and marks the goal stopped. Existing cancellation and admission checks enforce the envelope.

## Owner control and M1 limits

The owner stays responsible for starting and stopping goals, setting the budget, and approving actions that require approval. A goal does not grant new tool permissions. Goal RPCs require the owner's home session; phone and chat grants cannot expand these permissions. Action approval rules are scoped to the current bot or current goal when they are loaded and resolved.

M1 assigns work only to members already in the room. It does not add charters, routine ticks, coordinator-mention wakes, owner decision cards, bench members, desk assignments, board mirroring, or watches. A group without a goal keeps its existing routing and handoff behavior. The new name labels in bot context apply to every group.
