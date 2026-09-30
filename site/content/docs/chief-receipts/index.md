---
title: "Chief room receipts"
description: "Accepted ordinary requests routed to a room's chief get one saved acknowledgement before execution. Web, desktop and phone show the returned receipt immediately and merge its…"
source_path: "docs/chief-receipts.md"
---

> [Source: docs/chief-receipts.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/docs/chief-receipts.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

Accepted ordinary requests routed to a room's chief get one saved acknowledgement before execution. Web, desktop and phone show the returned receipt immediately and merge its event by the same message identity. A retry with the same nonce returns the same receipt. A failed admission has no successful-looking acknowledgement.

A bare “Hi everyone.” gets one chief greeting and no work run. It does not answer an approval question, cancel work or lower a fixed thinking pin. “Everyone, each of you say hello” still requests individual replies. Explicit mentions, replies and attachments retain their work path.

For document-to-Notion and installation preparation, the backend preselects from current room members using saved skills, roles, approved capabilities, pinned runtime, input locality and capacity. A descriptive role is not permission. Unknown access uses the chief's planning fallback; installation preparation stays on the task's computer. The receipt does not authorize a service write or installation.

The choice is attached to the existing task and supplied to the chief's normal turn. Dispatch rechecks membership, pin and eligibility at the existing delegation boundary, preserving root budgets and member pins. A committed request shows “Messaged &lt;bot&gt;”; a busy member shows “Queued for &lt;bot&gt;”; an approval-held peer request shows “Waiting for approval”. Request detail is expandable. Worker start is not promised to be instant.

## Extending the policy

Add receipt keys in `packages/contracts/src/chief-loop.ts`, templates and operation rows in `packages/core/src/chief-loop-policy.ts`, and translations in every web catalog and the phone catalogs. `CHIEF_TASK_RULES` covers the existing task vocabulary; `CHIEF_OPERATION_RULES` is the one place for capability requirements, preferences, ranking and no-match treatment. Extend the saved fact projection rather than parsing a bot name or directory text. Do not add live probes to receipt admission.

Copy the pure policy fixtures for renamed/reordered members, busy capacity, missing/unknown capability and fixed high pins. Response/event identity merging lives in shared core. Receipts are presentation-only and excluded from agent history. Native runtimes without verified preparation/accounting capabilities remain on the existing actionable-refusal path, never a hidden replacement pin.

## Timing and acceptance

The under-two-second target applies to send intent through visible chief receipt on a healthy stack. RPC return, an optimistic owner bubble, queue wait and first model token are not receipt-paint measurements. The opt-in client trace includes a request-specific `client.receipt.painted` boundary after two frames with the receipt visible; no run or token metric is invented for a greeting.

The isolated CI Postgres journey checks nonce replay, selected-member admission, unchanged budgets/pins after reload, member-removal races and greetings during pending work. The CI browser journey measures send intent to visible paint and captures the receipt screen. Neither suite should be pointed at an owner's stack. Offline clients and unavailable servers or contended database locks cannot be guaranteed a receipt within two seconds. Tool-fed progress, revision-fenced corrections and canonical blocker projection are later slices, not claims of this change.
