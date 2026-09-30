# Bot decision evidence

Ardur can record signed evidence of a bot's tool decisions. Recording is off by
default. A space owner can turn on **Record evidence of bot decisions** in the
Dashboard's Governance panel on web or desktop. Other members can see whether
recording is on, but cannot change it. Turning recording on does not backfill old
runs; turning it off does not remove evidence already recorded.

## What is recorded

When recording is enabled, Ardur appends one signed record for each observed tool
decision: allowed, asked, approved, denied, expired, or unanswered. A request and
its later approval or denial are separate decisions, not duplicate tool executions.
Each record includes the tool, action class, a redacted target, decision and policy
metadata, timestamps, run identity, and hashes of the arguments. The argument
values themselves are never included in the decision journal. Targets are reduced
and redacted, not a copy of the original arguments.

Records are chained in order and signed with the space's key. At the end of a run,
Ardur signs a seal naming the final record and decision totals. Evidence recording
failures are counted as gaps; a bot's successful run does not by itself mean its
evidence is complete or verifies. Argument hashes are commitments, not encryption,
and can reveal guesses about predictable inputs. Downloaded evidence is not
encrypted; treat its remaining metadata as potentially sensitive.

## What verification proves

With a public key obtained through a trusted channel, a valid chain and seal show
that these records were signed by the holder of the space's key and were not
edited, reordered, removed from the middle, cut short, or extended after that
seal. The seal matters: checking a chain alone cannot detect a removed tail.

Verification does **not** prove that the app is honest, that every real event was
recorded beyond what the app saw, that the recorded rules or decisions were
correct, that a tool actually ran, what happened inside a tool, or that its results
were true. Anyone holding the private key can sign a different complete history.
A verified journal records decisions, not proof of safety or successful execution.

The public key in the same download is not an independent trust anchor. Before
trusting a result, compare its fingerprint with one the owner publishes through a
channel you already trust. A replacement bundle containing a replacement key can
verify against itself. The app does not yet provide a public fingerprint publishing
service, key rotation, or revocation.

## Run states

Web, desktop, and mobile use the same evidence state definitions. No status is
shown for **Evidence off**, preserving the normal conversation when nothing was
recorded.

| State | Meaning |
| --- | --- |
| Evidence off | No recorded decisions, seal, or reported gaps. Recording may be disabled or the run may not yet have recorded its first decision. |
| Recording | The run has evidence and has not finished. A final seal is not available yet. |
| Not sealed | The run finished but no valid end-of-run seal is available yet. Sealing may still be pending or may have failed. |
| Verified | The server checked the chain and seal successfully, with no reported gaps. |
| Evidence gap | The chain and seal verify, but the app reports missed evidence writes. Inspect the status for the number of gaps. That count is app-reported, not independent proof of completeness. |
| Check failed | Verification failed. Details contain failure codes only, not journal contents. |

A verification failure takes precedence over recording or sealing status. A
completed bot response is not a substitute for checking its evidence.

## Download a run

On web and desktop, open the bot response's **More** menu and choose **Download
evidence**. The action appears only when the run has a valid seal. A member may
download only runs they can already see; space membership does not open another
member's private thread. Unsealed, absent, or failed evidence returns a conflict
with its state instead of an invalid archive.

On mobile connected directly to a server, tap a sealed run's evidence status,
choose **Download evidence**, and save or share through the system share sheet.
The temporary cache file is removed after sharing. In paired-device mode the
status remains available, but download is left to web or desktop because the
paired RPC transport does not carry HTTP archive downloads.

The archive is named `ardur-evidence-<runId>.tar.gz` and contains exactly:

- `journal.jsonl`: signed decision records in recorded order.
- `seal.jwt`: the signed end-of-run seal.
- `evidence-public.pem`: the space's public key.
- `README.md`: bundle instructions and trust limitations.

## Check without the app

Obtain the independent [Ardur Evidence checker](https://github.com/ArdurAI/ardur-evidence)
and follow its installation instructions. Extract the archive to a new folder,
compare the public key fingerprint with the owner's trusted published fingerprint,
and run this command from that folder (also included in the bundle's README):

```sh
ardur verify --chain-only --receipt-public-key evidence-public.pem --seal seal.jwt journal.jsonl
```

This is the bundle format's `EVIDENCE_CHECK_COMMAND`. The checker runs independently
of Ardur and checks the downloaded chain and seal; the app's status is not the
checker result. To derive the key fingerprint used as the key ID, hash the public
key's SPKI DER bytes with SHA-256:

```sh
openssl pkey -pubin -in evidence-public.pem -outform DER | openssl dgst -sha256
```

Compare all hexadecimal digits with the owner's `sha256:<hex>` fingerprint. A
successful check against an untrusted downloaded key establishes internal
consistency, not the identity or honesty of the signer.

Not included: encrypting stored evidence, key rotation and revocation, a second
signer (the computer that ran the tool), or a public place to publish the key
fingerprint. Spend and risk gates are not implemented by decision recording.
