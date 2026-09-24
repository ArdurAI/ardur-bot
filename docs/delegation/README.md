# Delegation admission

Every new direct message, group handoff, helper and lasting child enters through
`admitDelegation` in `packages/db/src/delegation.ts`. The caller creates any task,
run or child bot in the same transaction. Refusal rolls the transaction back and
returns a typed, one-sentence problem. Existing bots retain their own resolved
pin. Helpers and new children inherit the parent's captured pin, connection,
optional runtime kind and computer policy.

## Limits and accounting

The root task row is locked before admission. `delegation_roots` persists the
counters so separate workers share the same limits. Defaults are one level of
delegation, four active descendants, six hops, twelve total descendants,
120,000 tokens and one hour from the root run's creation. Each admission reserves
10,000 tokens and shares the root deadline. Cycles are rejected before depth is
checked. These are server defaults, with no P1 budget editor.

Token usage includes the coordinator and helpers. Recorded consumption replaces
reserved tokens; terminal workers release unused reservations. A refusal reserves
nothing. Provider usage can arrive after a completion, so late usage increases
consumption without releasing an already released reservation. Enforcement uses
reported token usage; an in-flight provider response can cross its reservation
before the next stop check. This is not a prepaid billing guarantee.

Usage rows and events record root task, delegation, requester, actor and depth.
Money remains null without pricing provenance, including local and subscription
usage.

## Authority and destination

The admitted ceiling intersects requester, recipient and space policies, inherited
authority, and any Dispatch device/channel grants. Execution rechecks current
policies. A recipient cannot gain an MCP tool by borrowing a broader recipient
assignment: both the recorded tool intersection and the requester's current grant
must allow it. Scoped installed and Pipedream connections use their existing
resource identities. Connector routes without a stable resource identity are
refused during delegation; this includes the current resource-less Composio routes.

Allowed model destinations can be set for a bot or space: any, local only or exact
listed hosts. Local means a loopback endpoint, not a provider name or a LAN address.
Unknown destinations pass only an unrestricted policy. The root resolver checks
its resolved endpoint; admission also checks the requester policy. A connection
edit that changes the admitted destination refuses execution. This policy checks
model destinations, not every possible network operation performed by tools.

## Completion, approval and stop

The bot the human addressed is the coordinator. Peer progress is retained as
`delegation.progress` events without notifications. Finishing a worker writes one
durable message in the coordinator's thread, keyed by the delegation id. Completion
says "completed, awaiting acceptance". `accept_delegation` explicitly accepts it and
updates that same summary; completion never implies acceptance. An owner can ask
the coordinator to accept a specific handoff.

Approvals stay bound to the original execution effect. Their single coordinator
card names both requester and acting bot. Delegated approvals do not offer a
persistent "Always" grant.

`requestCancel` records `cancel-requested` throughout the tree. Executors abort
their own work and reuse Dispatch's background-work stop confirmation. Only then
is cancellation confirmed and remaining capacity released. Stop also covers runs
waiting for input or computer takeover. After a worker restart, stopping its parent
confirms and releases any remaining helper admissions owned by that run.

`delegation_status`, `stop_delegation` and `accept_delegation` expose ids and lifecycle
to the coordinator. The first two accept an optional earlier root task id. Web
Activity shows requester-to-worker lines and a tree Stop control; mobile shows the
same read-only lines. A running descendant keeps the tree visible even after the
coordinator finishes.

## Task files

Delegated work receives a durable directory under `tasks/<root>/<delegation>` on
the selected computer. If its source workspace has a Git HEAD, it receives a
detached worktree; otherwise it receives an artifact directory. Helpers use their
own workspace when invoking parent-executor tools. Command recordings resolve the
same working directory as execution. Workspaces are organizational isolation,
not security boundaries. Absolute paths and shell authority remain governed by
the existing computer and approval policies. Worktrees and artifacts are retained;
there is no automatic cleanup or merge into the source checkout.

## Review and rollout

Apply `20260924000100_delegation_admission` before updated API or worker processes.
It uses the mapped `spaces`, `bots`, `runs`, `usage_records`, `delegation_roots` and
`delegations` tables. Existing history is not backfilled with invented lineage or
prices. Drain old workers before switching admission behavior so an old process
cannot bypass the new admission transaction.

Offline tests cover shared fake-worker admission, refusal rollback, snapshot
inheritance, policy intersection, locality, cancellation states, one summary,
explicit acceptance, approval routing, usage attribution and the existing dispatch
paths. They do not replace a PostgreSQL migration test or a live provider stop test.
The web Activity E2E adds a `delegation-lineage` screenshot for CI.

Operators notice one coordinator and fewer interruptions. Builders get durable
limits and task files. Researchers can inspect the actual executing pin. Team
leads can attribute usage and approvals. Local-first users can refuse remote or
unknown model destinations. Task cards, Team view and compare mode remain outside
this change.
