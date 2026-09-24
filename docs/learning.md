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

   `configure` accepts only `enabled`, `reviewerPin`, and `budgets`. Inspect `enabled.destination` before running a review. When initially
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
is the empty state. Applied entries show “Applied”, “Undo”, and “no observations yet”; outcomes
are a P2 feature. Confidence is a model estimate, not a probability of success.

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
remain display-only. Policy suggestions, pin insights and harness issues say “This suggestion
cannot be approved here yet.” Shared skills say “Shared skills need a reviewer — coming later”.
No tool authority, pin, shared audience, code or publication permission changes through learning.

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

1. Generate the client and apply `20260923220000_learning_consent` to a disposable local
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
