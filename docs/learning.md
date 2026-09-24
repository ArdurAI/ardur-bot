# Learning reviews

Learning is disabled by default. Enabling it lets a configured model produce proposals after a
run finishes or receives feedback. It cannot apply a proposal, change a pin, change an approval
default, or call tools. A pass that changes nothing is a normal result.

## Signals and documents

Thumbs on bot messages are durable feedback, with an optional reason and edit/retract support.
They do not create conversation messages or start bot runs. The server records the message
origin and authenticated author; a `user` message role alone does not establish authorship.

The reviewer receives two channels. Authenticated human instruction spans can authorize intent.
Server classifications of outcomes can support conclusions. Raw tool results, fetched files,
web content, peer messages and model summaries are excluded. Ambiguous quoted or mixed content
is deferred. The model receives target identifiers and revisions, not existing document bodies.
Credential redaction runs before review and before proposal persistence.

Skill catalogs point to the same document lifecycle as memory. Expected revisions prevent stale
edits. History, restore as a new revision, tombstones, provenance and export use the existing
memory service. Recording metadata stays with taught skills; editable playbooks live in
documents. Unknown/imported origins and protected skills cannot be written by a run. The common
memory writer enforces protection too, including writes addressed by path.

Exposure records identify the run attempt, document, revision and hash of delivered content.
Catalog listings are not exposures. Memory injection and tool reads report truncation after
bounding their content. Routine references expand during execution so attribution uses the
revision actually delivered.

## Configure and inspect locally

1. Generate the database client and apply the migration to the local development database:
   `pnpm db:generate` and `pnpm --filter @ardurbot/db exec prisma migrate deploy`.
2. Start the local application and worker with `pnpm dev`. Use a model runtime and configure a
   connection in Settings. Sign in as the owner of the space and select that space.
3. In the web development app's browser console, use its authenticated client:

   ```js
   const { rpc } = await import('/src/lib/rpc.ts');
   const settings = await rpc.learning.settings();
   const enabled = await rpc.learning.configure({
     enabled: true,
     reviewerPin: settings.destination,
     budgets: settings.budgets,
   });
   ```

   `configure` accepts `enabled`, `consolidationEnabled`, `reviewerPin`, and `budgets`. Inspect `enabled.destination` before running a review. When initially
   unset, the reviewer captures the space default connection at medium effort. Later changes to
   the default do not replace that saved pin. An unavailable model, unsupported effort or revoked
   connection pauses the review with a sentence instead of selecting another model.
4. Finish a bot run with a reusable instruction, such as a requested procedure format. Add a
   thumbs reason on its reply. Wait for the debounced `learning.review` worker job, then inspect:

   ```js
   const { reviews, proposals } = await rpc.learning.list({});
   console.table(reviews);
   console.table(proposals);
   ```

   A successful proposal has `status: "pending"`, a server-computed `diff`, admissible
   `evidenceIds`, and confidence labelled `model estimate`. A `no-change` execution is valid;
   there is no required proposal count. `learning.review({ runId })` requests another delivery of
   the job but the same run/generation/watermark/policy key is idempotent.
5. Inspect `review_executions`, `learning_proposals`, `proposal_evidence`,
   `run_knowledge_exposures`, and `feedback` in the local database when checking attribution.
   Clear or delete the source thread: derived bodies disappear and a content-free audit remains.

## Limits and decisions

Defaults allow 30,000 review tokens per bot and 150,000 per space per UTC day, three proposals per
review, a 30-second timeout, 2,000 output tokens and 12,000 output characters. A reservation uses
prompt characters as a conservative upper bound and is settled with reported usage. Failed
calls without usage retain their reservation for the day. Hosted reviewers may incur model
charges; a compatible local connection does not require a hosted vendor.

The review key deliberately allows at most one model call. A worker crash after claiming it
leaves an incomplete audit and a conservative reservation, rather than repeating a potentially
billed call. New evidence produces a new key. Review proposals carry a 30-day expiry. Approval, rejection, undo and explicit personal grants
are available in the Learning inbox described below.

The database migration moves existing PostgreSQL skill bodies into the revision journal and
clears compatibility body columns. Other document locations migrate lazily through the selected
store. Old message roles are not retroactively promoted to authenticated human origins.
Steering summaries retain server origin and author; when the runtime has no semantic course-change
classification, the kind remains `other`.

The operator gets feedback without another bot response. The builder gets revision-safe skill
editing. The researcher gets exact document exposure and pin fidelity. The team lead gets bounded
spend and review audits. The local-first user can keep the review on a compatible local model.

## Review, apply, and undo

Open Settings → Memory & Skills → Learning on web or desktop. In a bot's panel, open
Learning for that bot's suggestions. Mobile has Learning in account settings and in the bot
settings. A space member can review their own proposals; only the space owner sees the space
learning switch. The collapsed cards show content and scope. Details reveals the server diff,
rationale, separately authorized evidence, model estimate, originating run, reviewer pin and
policy version. The actual configured review destination is shown before enabling learning.

Pending work says “3 suggestions to review”. Only applied changes contribute to “learned 3
things this week”, using the last seven days and excluding undone changes. “Nothing to review.”
is the empty state. Applied document entries show “Applied” and “Undo”. Details includes observations for the applied revision. Confidence is a model estimate, not a probability of success.

Approve independently checks current membership, personal ownership, source-thread generation,
expiry, expected revision and target protection. It commits through `MemoryService`, with author
`learning-loop`, approving user or grant, both pins and the review-policy version in History.
For database documents, the proposal, revision, content-free audit and delivery outbox share one
transaction. Semantic delivery is queued after commit and remains recoverable by reconciliation.
Edit redacts again and recomputes the diff on the server before approval. Rejection retains only
a fingerprint for suppression after proposal bodies are purged. Suppression is conservative:
the same content, target and scope remain suppressed; another evidence identifier alone does
not unlock automatic apply.

Undo commits a new revision. If the applied change is still the head, the new revision contains
its parent content. If later work exists, an inverse is applied only where its changed span and
neighbours have one unambiguous match. Overlaps and ambiguous matches return before, applied and
current versions for review, without writing. Undo of a newly created document creates a
tombstone; later edits to that document cause a conflict instead. Existing Documents → History
shows all those revisions. Clearing a source thread purges proposal bodies and evidence through
the P1-1 database trigger, so a queued grant cannot apply them. It preserves already approved
memory revisions and content-free action audits.

Preferences are restricted to boolean `bot.notifyOnFinish` and `bot.autoSpeak`, both existing
visible bot settings. Setting history is retained as `preferences/` documents for inspection;
it is excluded from prompt memory, memory search and semantic delivery. Other preference keys
remain display-only. Pin insights and harness issues say “This suggestion
cannot be approved here yet.” Read-tool policy suggestions require separate human approval as described below. Shared skills say “Shared skills need a reviewer — coming later”.
No pin, shared audience, code or publication permission changes through learning. Only explicit human approval of a policy suggestion can create a bot-scoped read-tool rule.

## Personal grants

Five manual approvals in one category and exact scope make an offer available. The offer is
“Apply memory suggestions for this bot automatically” (or its skill/personal equivalent), with
“Turn on” and “Not now”. Nothing creates a grant from the count alone. The default limit is five
changes per UTC day; the API accepts a limit from one to twenty and an optional expiry. Grants
are limited to memory or skills in bot or user scope. P1-1's reviewer continues to propose in
bot scope by default. Web/desktop lists active grants with Revoke. Mobile has no grant controls.

The review job can request automatic apply only with a matching grant. The same apply service
reads the grant again while holding the memory writer lock, checks revocation, expiry, current
learning settings, suppression and the daily limit. Revocation takes the same lock, so queued
work cannot reuse a stale authorization. Automatic applications do not count toward the
five-manual-approval offer. Repeated review-job delivery can finish pending granted applies
without repeating the model review.

## Local acceptance walkthrough

1. Generate the client and apply `20260923240000_learning_consent` to a disposable local
   development database, then start the app and worker. No hosted provider is required.
2. Sign in as a space owner. Select one space and open Settings → Memory & Skills → Learning.
   Inspect Review destination, then turn on Learning. The switch preserves the configured pin
   and budgets; it does not grant automatic application.
3. Complete a bot run containing a reusable instruction and add feedback if useful. Wait for the
   review job. A no-change result is normal; a pending proposal appears with Approve/Reject/Edit.
4. Expand Details, read the diff and open Evidence. Edit if needed, then Approve. The card stays
   in place and becomes Applied. Verify only the applied count uses “learned”.
5. Open Documents for that bot (or user scope), select its `learned/` or `skills/` document, and
   open History. Check the new revision, learning-loop author, approving user and model.
6. Return to Learning and choose Undo. Reopen History: a new revision restores the parent, or a
   newly created document is tombstoned. For a separate conflict check, make an overlapping
   manual edit after approval and then Undo; both versions must appear and the head must remain.
7. Repeat manual approval in one category and scope until the fifth. Check that Turn on is an
   offer only; opt in and then Revoke before another queued application. On mobile, verify
   Approve/Reject, before/after details and Undo, with no grant controls.

Offline tests cover consent, revision conflicts, redaction, typed preferences, suppression,
provenance, transaction rollback, source invalidation, grant limits/revocation, UI copy and
native rendering/actions. The web E2E scenario captures pending and applied inbox states for CI;
it uses deterministic response fixtures and does not claim to validate a model's proposals.


## Outcome observations

`observeLearningRevision` in `packages/adapters/src/learning-outcomes.ts` projects records for a
selected immutable document revision. Applied cards open this projection in Details. Documents →
History → Observations also works for a revision written by the owner. The bot panel's applied
weekly count opens the same Learning inbox. Web and Electron share the interface; mobile uses
native controls and the same observation contract.

An exposed run is a terminal run with an actual `RunKnowledgeExposure` for that revision before
its completion. Multiple attempts, injections, reads and invocations in the same run count once.
An unfinished run is disclosed and excluded from the terminal-run denominator. Truncated
exposures count but are disclosed. A run that started before the comparison window still counts
if it consumed the revision and completed in the after window. A catalog listing never
establishes exposure.

The after window is `[max(revision.createdAt, now - 30 days), now)`. The before window has the
same duration and ends at `revision.createdAt`, exclusively. Before runs must start and finish
inside that window. They must match an exposed run's bot, complete recorded runtime pin
(provider, model, effort, credential binding and pin revision), trigger and routine identity.
Missing pins do not match. Trigger/routine identity is a task-class proxy; it does not establish
equal difficulty, inputs, tool configuration or model weights. Concurrent changes are not
controlled. These observations do not establish causation.

A correction is either active explicit negative feedback with a nonempty reason, or a
server-recorded human steering summary of kind `correction`. These are separate numerators.
Reasonless negative feedback, positive feedback, retractions, peer messages, `other` steering
and added requirements are not corrections. Feedback uses its last edit time; steering uses
its recorded creation time. After corrections must occur after the first exposure and before
the observation cutoff. Before corrections must occur between run start and the revision
cutoff. Multiple corrections in one run are multiple events, not multiple runs. Later retractions
change the projection; it is a current view of surviving evidence, not an immutable experiment.

The visible sentence is “2 corrections in 7 exposed runs; before: 3 in 9 comparable runs”. Either
sample under five also shows “Not enough runs to tell”. One exposure is unmeasured. No feedback
is not approval. Every observation includes both windows, denominators and a `missing` list.

Failures are counts of distinct runs per recorded class: task, integration, provider and pin.
A run can have more than one error class. Pin problems and provider failures come from typed run
failure metadata. Tool errors use a recorded `errorClass` where available. New tool audits identify connector-boundary
errors as integration errors, specific provider errors as provider failures, and typed pin errors
as pin failures. The generic provider classification `other` stays unknown. Unclassified failures
stay unknown; an infrastructure failure is never inferred to be a task failure. Denied effects
are counted separately from cancellations. The current denial producer does not distinguish an
inappropriate request from a safety-preserving denial, so its records share an explicitly
labelled unknown bucket. Tool completion audits are best effort, and absent records do not prove
absence of errors.

Time and token comparisons show whole-number means and the number of runs contributing to each
mean. Deltas are withheld below five samples in either arm. Missing usage is not zero usage.
Elapsed time includes waiting because separate waiting-time coverage is unavailable. P1 has no
persisted task-contract acceptance producer; the projection contract supports acceptance, but
current stored runs report that gap. Neither completion nor positive feedback substitutes for
acceptance. No monetary estimate is presented: price coverage, local compute and review/curator
overhead are not sufficiently measured.

## Curator and consolidation

Settings → Memory & Skills → Learning → Curator contains Run now, Propose consolidation and Last
check. The space owner can enqueue a check; the worker rechecks ownership. The weekly Graphile
schedule runs Monday at 03:00 UTC for enabled spaces. It checks each current member's own data.
Reports contain counts, opaque flagged/proposal ids, elapsed milliseconds and reported tokens,
with no source content. The owner can inspect the reports; a missing completion after a worker
crash is not a successful check. Deterministic checks do not call a model.

A learned skill is stale only after thirty days without exposure and without a new revision.
Protected skills, skills referenced by routines (including paused routines), and owner-tagged
recovery/troubleshooting skills are exempt. Keep for recovery sets this metadata; it does not
change the skill body or tool authority. Exposure clears staleness on the next pass. Nothing is
archived or deleted by the curator.

A possible regression requires at least three correction events, at least five terminal exposed
runs, at least five comparable before runs, and a strictly higher correction-event/run ratio.
Every exposed pin/task class must have a before match; an unmatched mixture is not flagged.
It creates a pending memory/skill proposal with `operation: revert-suggestion`, targeting the
applied revision and carrying the observation. Human approval invokes the same inverse-change
function as Undo. Intervening overlapping edits return a conflict. A curator flag never reverts
anything, and a learning category grant cannot approve it.

Consolidation is a separate opt-in and defaults off. A deterministic overlap filter chooses two
eligible learned skills in the same bot scope. Only then can the reviewer pin receive bounded,
redacted skill content as untrusted evidence. The runtime has `tools: "none"`; tool/ask/takeover
output fails closed. P1 token reservations, per-bot/per-space daily limits, timeout and output
bounds apply. Failure to resolve the pin does not choose another provider. Usage that a provider
does not report remains unknown; a reservation remains charged against the daily budget.

A consolidation proposal records every participating document and revision. Approval rechecks
those revisions and protection. It adds a class-level skill and retains the sources; automatic
retirement of the source skills is deliberately excluded. Undo tombstones the new skill unless
later edits conflict. This trades immediate reduction of the skill catalog for reviewable,
non-destructive reversal. Consolidations always require a human, even if skill auto-apply is on.

## Journey and export

Timeline sits beside Inbox on web/Electron; mobile exposes a read-only timeline. Entries derive
from immutable revisions and `learning_audits`: applications, reversals, grant creation and
revocation, and curator flags. Filesystem modification time never supplies an entry date.
Proposal/revision identifiers link entries back to their evidence and observations. After source
history is cleared, content-free audit identifiers can outlive a proposal body. Proposal links
load their authorized record directly, including records outside the inbox's latest 100 items.
Removed records cannot be opened; their surviving audit identifiers remain exportable.

The existing bot JSON export includes `learning.journey` and `learning.observations`. Importing
an export does not create approval rules or grants. Document bodies and history continue through
the existing document lifecycle; P2 does not create another authoritative document store.

## Bot-scoped policy suggestions

The curator groups authenticated human approval decisions by exact bot and exact read-classified
tool during the last fourteen days. Five distinct approvals can create a pending suggestion:
“You allowed <tool> 6 times for <bot> — allow it for this bot?”. Consequential, compound mutating
and unknown tools are excluded using the existing conservative read classifier. P2 records the
actor and decision time when an approval is answered; historical effects lacking that provenance
are not retroactively treated as human approvals. A successful effect alone is not an approval.

Approve rechecks that the proposal names a bot and a read tool. It atomically records a scoped
`always_allow` rule and a learning audit. It never accepts a learning grant. The additive
migration gives old rules `botId = null` and `scopeKey = all`, retaining their former behavior.
New scoped rules use `bot:<id>` as their uniqueness key and carry that bot id through the API and
executor. Only a matching bot can resolve the rule. A scoped rule takes precedence over an
all-bot rule; equally specific require-approval rules win ties. Mandatory integration/explicit
security approval remains mandatory. Other bots still obey their previous rules.

Settings → Action confirmations displays the named bot or All bots for each rule. Removing a
rule is an explicit human action there. Rejecting a policy suggestion suppresses the same tool
and bot for thirty days; later rejection starts another thirty-day period. No count, report,
model output, scheduled check, import or existing category grant changes authority by itself.

## P2 local verification

1. Apply `20260924010000_learning_outcomes` to a disposable development database after generating
   the client. Open an applied memory or skill proposal. Expand Details and inspect both windows,
   the correction channels, run counts and missing-data statements. With fewer than five runs,
   check that “Not enough runs to tell” appears. Inspect an owner-authored revision from History.
2. As owner, open Curator and choose Run now. With consolidation off, verify zero model calls and
   a content-free Last check report. Keep a rarely used skill for recovery, run another check,
   and verify it is not marked stale. A regression is a pending proposal, not an automatic Undo.
3. Approve the same read-classified tool five times for one bot within fourteen days, using an
   explicit ask rule. Run the curator, review the policy proposal and approve it. Action
   confirmations must name that bot. Run the same tool for a second bot with the same ask rule;
   it must still ask. Reject another suggestion and confirm a later check does not recreate it
   during the suppression period.
4. Open Timeline and inspect a revision, an Undo and grant changes. Export the bot JSON and check
   the journey and observations. On mobile, inspect the same observations and read-only timeline.

Operator: applied changes have readable observations and reviewable Undo proposals. Builder:
exact revision, scope and pin comparisons remain inspectable. Researcher: windows, sample sizes,
unknowns and exports make the measurement limits explicit. Team lead: policy decisions and grant
changes remain in the audit trail with bot scope. Local-first user: deterministic curation needs
no hosted model, and optional consolidation uses the already selected connection.
