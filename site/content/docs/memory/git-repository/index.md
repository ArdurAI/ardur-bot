---
title: "Git repository memory"
description: "Git repository memory helps builders inspect and own shared documents, researchers keep portable revision history, team leads review proposed facts, operators recover from sync…"
source_path: "docs/memory/git-repository.md"
---

> [Source: docs/memory/git-repository.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/docs/memory/git-repository.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

Git repository memory helps builders inspect and own shared documents, researchers keep portable revision history, team leads review proposed facts, operators recover from sync failures, and local-first users see the destination of remote sync. Built-in memory remains the default.

Only **space-shared** documents enter the repository. User and bot documents stay in built-in protected storage. Repository access grants access to every committed shared document and its history; prefixes do not provide access control.

## Connect a test space

1. Create an empty private GitHub repository. Do not initialize a README or other files.
2. Create a fine-grained personal access token restricted to that repository with **Contents: Read and write**. Follow [GitHub's token guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens). Alternatively, add a write-enabled repository deploy key and use an `ssh://git@github.com/owner/repository.git` URL.
3. In Settings → Memory, select **Git repository**. Enter its HTTPS URL, token, branch (`main`), and **Publish directly**. Choose **Test connection and preview**, review the document/revision counts, then **Use this location**. The credential field clears after the test; credentials are encrypted in the existing secret store and are not returned to clients.
4. Import `packages/testkit/src/fixtures/memory-v1.json` into the test space. Remap its user scope to **Space shared** and its bot scope to a test bot. Preview, then import. The shared example should appear in GitHub under `memories/space-shared/`, with both revisions in `history/`. The private example must remain absent from GitHub.
5. Edit the shared document. History shows a new commit ID. The revision first shows **Saved locally. Sync pending.** and becomes pushed after the worker finishes. GitHub shows a commit authored with the acting member's display name and a per-space `@memory.invalid` identity.
6. Select **Propose on a branch**, preview the mode change, and confirm. Subsequent writes go to `ardur/proposals/<space>/<machine>`. Create and merge a pull request in GitHub to publish them. Ardur records the proposal branch; it does not create pull requests. Shared recall uses the configured branch until the next session-start pull observes the merge.
7. Use **Export with history** to retain every revision and its provenance. Imports and restores use the same lifecycle as built-in and Obsidian memory; a restore creates a new revision.

## Deployment

API and worker require system Git and OpenSSH. The Compose images install those packages; no new JavaScript runtime dependency is required. Host installations must make `git` and `ssh` available in the service's executable path. The transport supports the Unix API/worker environment; desktop uses that environment through Compose on macOS, Windows and Linux.

Application-managed storage is below `DATA_DIR/memory-git`. A persistent machine identity belongs to that storage directory, not to the shared database. API and worker must share that directory. Each space/repository has its own clone and app-private sync state. The desktop memory Compose override mounts this storage into API and worker only; neither the bot computer nor the supervisor receives the repository mount.

`MEMORY_GIT_ALLOWED_HOSTS` is a deployment-owner comma-separated hostname allowlist and defaults to `github.com`. HTTPS redirects, credential-bearing URLs, arbitrary protocols and nonstandard ports are refused. `MEMORY_GIT_KNOWN_HOSTS` can name a deployment-owned SSH trust file for additional allowed hosts. GitHub's published Ed25519 host key is included; host verification is strict. Passphrase-protected deploy keys are not supported by the noninteractive transport; use a repository token or a dedicated deploy key.

Git runs without a shell, with a minimal environment and an empty hooks directory. It does not read the user's Git/SSH configuration. Staging uses exact paths, raw object hashing and an app-owned index; checkout, merge drivers, submodules and filters never run. Literal `-c filter.*=` is not a valid Git configuration key. Instead, the app removes repository-defined configuration, disables attributes for filters, and uses `hash-object --no-filters`. See [Git configuration](https://git-scm.com/docs/git-config) and [credential handling](https://git-scm.com/docs/gitcredentials).

## Offline operation and recovery

An accepted save commits synchronously before a Graphile job is queued. Push jobs replace an older waiting job for the same space and retry failures. Git commits are the durable outbox if queue submission or status persistence is interrupted. API/worker writers are serialized by the existing space advisory lock.

Session-start pulls have a ten-second deadline. A failed or timed-out pull leaves the last copy readable. A failed push leaves the commit local and retryable. **Retry** queues synchronization; it does not erase or rewrite local commits.

Concurrent edits retain the upstream document and a sibling ending in `.conflict-<machine>-<id>.md`, with both revision chains preserved. Paths include member and machine identities. History is projected as ordinary P1a Markdown files so an export needs no Git installation to interpret it.

If the remote no longer contains its last observed tip, synchronization stops. A full copy of the local repository, including offline commits, is quarantined outside the clone. **Review saved copy** exports the still-readable local documents. The owner must review the rewrite and the retained data before reconnecting to a reviewed repository. There is no automatic force-push, reset, or replay of quarantined history. A deliberate upstream erasure must not be silently undone.

Deletion removes a document from recall and retains its tombstone and history. GitHub, other clones and backups may retain older content. Redaction runs before persistence and staging, including known connection credentials; suspicious bytes stay in app-private quarantine. Pattern detection cannot recognize every arbitrary secret.

## Visible copy

The destination line is “Syncs to &lt;host&gt;”. “Saved locally. GitHub sync failed.” appears with **Retry** only after a failed push; “Working from the last copy” appears after a failed pull. The setup form says “Only space-shared documents go to this repository.” because the privacy boundary affects the decision to connect. The mode preview says “Shared recall will use proposed facts after merge.” when proposal mode is selected. These statements are shown at the relevant decision or failure, rather than in the main conversation.

Mobile displays destination, sync state, documents, history and commit IDs read-only. Configuration and recovery are available on web and desktop. CI's Settings screenshot is named `settings-memory-git`; native mobile status does not have a corresponding web screenshot.
