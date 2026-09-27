---
title: "Team goals"
description: "A team goal gives a group coordinator a bounded period to organize work in the shared room. The group needs a coordinator and at least two members. The deployment owner starts a…"
source_path: "docs/goals.md"
---

> [Source: docs/goals.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/docs/goals.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

A team goal gives a group coordinator a bounded period to organize work in the shared room. The group needs a coordinator and at least two members. The deployment owner starts a goal with an objective, optional completion conditions, a deadline, and a token limit. Starting a goal queues the coordinator's first turn without another chat message. One active goal is allowed per group.

The coordinator sees the objective, completion conditions, seated members, open assignments, used tokens, deadline, and status in each goal turn. The coordinator can use `assign` to give separate task cards to several seated members during one turn. Each assignment is admitted under the same delegation root. A card's earlier deadline takes precedence over the goal deadline. Repeating an identical assignment in one coordinator turn replays it; a different card for the same member creates another assignment. A worker's final reply appears in the room under that worker's name. A completed, failed, or cancelled assignment schedules one coordinator review when the group is active and its current coordinator is still a member. Completions wait behind active or approval-held work; a compatible linked peer reply may steer an active coordinator turn. Other members' replies are labelled by name in each bot's context.

## Desk requests

The active goal coordinator can also use `message_bot` to send a bounded task card to a different, current group member's desk thread. The request and receipt are visible in both threads; the worker's full result stays in its desk thread, and one completion summary returns to the coordinator's group thread. A busy recipient's request remains queued. A completed or cancelled card releases its reserved worker capacity and wakes the coordinator once.

The desk worker runs in `peerMode: "read-only"`. The card supplies the task and its allowed inputs; it does not grant the sender authority over the recipient. Only card-listed text, documents and artifacts may be read. URL inputs are rejected. The worker may report progress, attach an artifact to its card, complete the card, or return a result; requests for other actions are blocked for the coordinator to bring to the owner. This mode is supported only by Pi runtime connections. Other runtime kinds are refused rather than run without the boundary.

Each new desk request has a delivery row linked to its existing delegation and thread messages. The member running that card may answer its delivered request with `message_bot` and `inReplyToDeliveryId`; the server fixes the recipient to the original coordinator and accepts only a result or clarification question. It refuses another member, another root or space, an expired or already answered delivery, and a seventh hop. A completed card also records its result against the request when no explicit answer was sent. Replays with the same delivery key reuse the original record.

`Delivered` means the message was committed to the recipient thread. `Read` means a lease-fenced runtime acknowledgement confirmed its content entered a valid turn; `Replied` means a linked substantive result committed. Native runtimes without input acknowledgement stay Delivered with `read-unconfirmed`, so their chips never claim Read. Historical desk markers remain as stored; older messages without a marker remain merely sent. Ordinary status and FYI deliveries are quiet records for a later natural turn. An unsolicited result is treated as FYI and starts no run.

Linked replies share one durable wake batch per goal root, recipient, thread and authority fingerprint. A compatible active coordinator turn can take the batch as steering. Automatic completions and replies behind owner-origin work, held approvals, comparison work or a different root wait for a later turn. The dispatcher rechecks the unarchived group, its current coordinator and that bot's current membership; a changed authority fingerprint also fails the batch closed. No held approval is answered or cancelled for delivery. After a process failure, the reconciler scans pending batches and queued runs. If a turn ends before consuming its bound steering, the wake waits 30 seconds, then 2 minutes, then 5 minutes across interrupted attempts. Exhaustion or a permanent runtime problem fails it terminally with a room notice. Bodies stay in the thread messages rather than a second inbox copy.

A batch holds at most eight bodies and 16,000 prompt characters. The inbox refuses a twenty-first pending delivery per recipient and a fifth unresolved request per source run with `Inbox full` and one room notice. Each message remains capped at 8,000 characters and a chain at six hops. A delivery expires no later than one hour after creation or at the goal deadline. A wake may spend tokens or subscription quota; money is unavailable without recorded pricing provenance.

Desk dispatch is limited to two messages per coordinator turn, four per bot pair per minute within the goal root, and 12 goal-message wakes per hour. The goal's shared token, deadline, descendant and concurrency limits still apply. These limits bound the current goal workflow; they are not a general cross-goal inbox policy.

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

The owner may set the total token limit, deadline, per-worker limit, concurrency, and descendant limit at start. The deadline must be in the future and within seven days. Stopping the goal requests cancellation of its root task and marks the goal stopped. When the root deadline passes, the token limit is reached, or the root is cancelled, the goal becomes **Exhausted**. The room then accepts new messages as ordinary group work, and the owner can start a new goal. Existing cancellation and admission checks enforce the envelope.

## Owner control and M1 limits

The owner stays responsible for starting and stopping goals, setting the budget, and approving actions that require approval. A goal does not grant new tool permissions. Goal RPCs require the owner's home session; phone and chat grants cannot expand these permissions. Action approval rules are scoped to the current bot or current goal when they are loaded and resolved.

Room assignments still go only to members already in the room. Goals do not add charters, routine ticks, coordinator-mention wakes, owner decision cards, bench members, board mirroring, or watches. A group without a goal keeps its existing routing and handoff behavior. The new name labels in bot context apply to every group.
