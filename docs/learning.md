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
billed call. New evidence produces a new key. Review proposals carry a 30-day expiry; applying,
rejecting, reverting, grants, and the inbox are a later feature.

The database migration moves existing PostgreSQL skill bodies into the revision journal and
clears compatibility body columns. Other document locations migrate lazily through the selected
store. Old message roles are not retroactively promoted to authenticated human origins.
Steering summaries retain server origin and author; when the runtime has no semantic course-change
classification, the kind remains `other`.

The operator gets feedback without another bot response. The builder gets revision-safe skill
editing. The researcher gets exact document exposure and pin fidelity. The team lead gets bounded
spend and review audits. The local-first user can keep the review on a compatible local model.
