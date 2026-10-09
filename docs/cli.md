# Command-line tool

Send a bot a task from your terminal or a script. Pair the command line with your home once,
then use the same Devices scopes and revocation as a phone. No separate token or service is needed.

## Build and install

The CLI is currently built from source, not published as a registry package.
Use the repository's supported Node version (22.22.2 or newer) and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm --filter @ardurbot/cli build
node apps/cli/dist/ardur.mjs --help
```

On macOS/Linux, copy the self-contained executable into a directory on your PATH:

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 apps/cli/dist/ardur.mjs "$HOME/.local/bin/ardur"
```

Make sure `$HOME/.local/bin` is on PATH. On Windows, keep the bundle in a folder you control
and invoke `node <path-to-ardur.mjs>` instead of `ardur` in the examples below.
The workspace package also declares the `ardur` bin for package installers.

Building bundles the shared contracts with the CLI; it adds no new runtime package.
macOS and Linux use private file permissions. Windows requires Windows PowerShell and a filesystem
that supports access-control lists; pairing fails if it cannot restrict access to the current user.

## Pair

In your home, open **Settings → Devices**, choose **Pair device**, then **Copy pairing code**.
The copied JSON is the same payload encoded in the phone QR. It is not the short manual phone code.
Keep it private until it expires.

```sh
ardur pair '<copied pairing payload>'
ardur status
ardur bots
```

Quote the whole payload as one argument. The CLI also accepts its base64url-encoded form.
The first home link must be an HTTPS origin reachable from your terminal. For a server or
source checkout, set `ARDURBOT_DEVICE_LISTENER_ENABLED=true` and
`ARDURBOT_DEVICE_LISTENER_ORIGIN=https://127.0.0.1:43119` before starting the API.
The default bind is `127.0.0.1` and port is `43119`; configure
`ARDURBOT_DEVICE_LISTENER_BIND` and `ARDURBOT_DEVICE_LISTENER_PORT` for another private
address or port. A remote terminal or phone needs a reachable private origin, for example
`https://10.0.0.10:43119`, with the listener bound to that private address and firewall
access explicitly allowed. See [Server device pairing](self-host.md#pair-a-phone-or-command-line-device-with-a-server)
for the Compose override. Keep the application database and `ENCRYPTION_KEY` across
restarts to retain the certificate and encrypted home key. A TLS-terminating proxy
with another certificate will fail the pin; use direct access or TLS passthrough.
The local listener must be enabled when using a desktop home's network link.
Do not expose a listener without
checking its network boundary. There is no HTTP, redirect or unpinned fallback.
The exact certificate pin and the signed home proof are checked before pairing or signed requests.
A changed or expired certificate requires a fresh pairing.

Pairing writes `home.json` under `$XDG_CONFIG_HOME/ardur`, or by default:
- macOS: `~/Library/Application Support/ardur`
- Linux: `~/.config/ardur`
- Windows: `%APPDATA%\ardur`

On macOS/Linux the directory is mode 0700 and the file is mode 0600. Windows uses a protected
current-user ACL instead of relying on POSIX modes. The file contains the grant, home pins and an
**unencrypted private signing key**. It is not a hardware-backed or encrypted credential store.
Never share it, put it in a repository, or copy it into logs. The key is generated locally;
the CLI never accepts a private key as an argument or prints it.

## Send, wait and stop

Use a bot id from `ardur bots`, or its exact unique name. Duplicate names require an id.
Without a bot argument, the home uses this device's default bot.

```sh
ardur send "Builder" "Fix the public example issue and open a draft PR."
ardur send "Builder" --file brief.md --wait
ardur send "Builder" --file brief.md --wait --json
ardur stop <task-id>
ardur status --json
```

A task must be non-empty and no longer than 32,000 characters. Brief files are bounded at
128,000 UTF-8 bytes and must be regular files. Ordinary send prints the task and run ids.
`send --wait` reads the exact run, then its saved final message. It prints answer text,
not tool output or reasoning. A completed run without its exact answer is an error, not a pass.

### Recover a send or resume waiting

Choose a request id before sending if you may need to recover a lost admission response:

```sh
ardur send "Builder" "Reply with READY" --request-id example-request-0001 --wait
ardur wait --run <run-id> --timeout 180s --json
ardur runs list --limit 50 --json
ardur runs list --cursor <last-run-id> --limit 50 --json
ardur runs show <run-id> --json
ardur tasks show <task-id> --json
```

Request ids must be 16–128 characters. After a lost response, repeat the same request id and
identical message, bot id and optional fields. The client obtains a fresh signing nonce.
The home returns the original admission with its current dispatch state; it does not create
another task. Changed input under that id is refused. Different devices have separate request-id
namespaces. There is no automatic retry. Keep the bot's exact id when recovering a named send;
a changed name resolution is changed input.

Exact run and task reads remain available after leaving the latest 100 tasks. They are limited
to this device's admissions and the current user and space. Unknown and foreign ids receive
the same refusal. Message reads use the existing thread access checks and device projection.
Run pages contain at most 100 records (default 50), newest first, ordered by creation time and
then id. Use the returned `nextCursor` for the next page; null means the end.

Waiting is not streaming. It checks about every two seconds and each signed request needs a nonce
round trip. Polls read saved state; they do not start model turns. Work keeps the bot's saved
model and computer, normal costs and approvals. Each network request times out after 15 seconds.
Both `send --wait` and `wait --run` have a 180-second default overall deadline; `--timeout`
accepts seconds or an `ms`, `s` or `m` suffix. A deadline or interruption stops waiting,
**not the task**. Approval waits ask you to continue at home. Use `stop` to request cancellation;
only the run's later confirmation establishes that work stopped.

### Command results

Send, stop, wait, runs list/show and tasks show use the same versioned result family and exit
codes as `test bot`, with `command` and `data` added. JSON mode writes exactly one result to
standard output, including errors. Diagnostics never contain raw provider errors.

```json
{"version":1,"command":"runs show","bot":null,"runId":"run-id","taskId":"task-id","verdict":"pass","replyText":"","elapsedMs":12,"failureReason":null,"data":{"run":{}}}
```

The example abbreviates the run detail; its full fields are below. A successful show exits 0
even if the inspected run failed. Waiting on that failed run exits 2. Send without wait proves
admission only. Pair, bots and status retain their existing output and exit codes.

## Test a bot from a script

Pair once, then check a bot's final reply without opening a screen:

```sh
ardur test bot "Builder" --prompt "Reply with READY" --expect-contains "READY" \
  --timeout 180s --transcript "$HOME/bot-check.json" --json
```

Use an exact bot id or a unique, exact name. Unknown or duplicate names print candidate ids.
Only bots and one prompt per command are supported. There are no room, suite, regex or model-judged
checks in this stage. Matching is case-sensitive and checks the exact final message's non-reasoning
text before redaction. Other runs, threads, message ids, roles and progress blocks cannot pass it.

The default deadline is 180 seconds. A plain number means seconds; `ms`, `s` and `m` suffixes
are accepted. The deadline bounds home requests and polling. It stops waiting, **not the bot task**.
The result keeps any task and run ids received at admission. If the deadline or a connection failure
occurs before the admission response arrives, the ids may be unknown even though work was admitted.
Check at home before repeating the command. There is no automatic retry.

`--json` writes exactly one versioned result to standard output, including errors:

```json
{"version":1,"bot":{"id":"bot-id","name":"Builder"},"runId":"run-id","taskId":"task-id","verdict":"pass","replyText":"READY","elapsedMs":1200,"failureReason":null}
```

`bot`, `runId` and `taskId` are null until known. Verdicts are `pass`, `mismatch`, `failed`,
`stopped`, `deadline` or `error`. Reply text and failure reasons are sanitized and redacted.
Human output prints the ids, a plain verdict sentence and the reply, without terminal controls.

No transcript is written unless `--transcript` is supplied. Relative paths are resolved inside
your home folder, not the working directory. An absolute path explicitly selects another existing
folder you control. Parent folders must not be symlinks; on macOS/Linux the immediate parent must
be owned by you and not writable by other users. Parent traversal (`..`), symlinks and existing
targets are refused. Choose a new filename for each check. The file is created privately before
dispatch: mode 0600 on macOS/Linux, a current-user-only ACL on Windows. Filesystems without the
required protection or hard-link support are refused. Windows ACL execution needs platform acceptance.

The private JSON file records the prompt, reply, bot, task/run ids, verdict and timing; it is
updated when admission is received and when the command finishes. Credential-shaped values and
private keys are redacted using the shared redaction rules. It is an unencrypted client observation,
not a signed execution receipt. Keep it private; redaction is not a guarantee that arbitrary
sensitive prose is removed.

### Script examples

```sh
if ardur test bot "Builder" --prompt "Reply with READY" --expect-contains "READY"; then
  echo "Bot check passed"
else
  code=$?
  echo "Bot check failed (exit $code)" >&2
fi
```

Keep the command's exit code when parsing JSON; do not let the parser hide a failed check:

```sh
code=0
result=$(ardur test bot "Builder" --prompt "Reply with READY" --expect-contains "READY" --json) || code=$?
printf '%s\n' "$result" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["verdict"], r["runId"], r["taskId"])'
exit "$code"
```

Each check creates one ordinary home turn with the bot's saved model, computer, costs and approvals.
Polling reads saved state and does not add model turns.

### Test exit codes

These codes apply to `test bot` and the Stage 3 commands above. Exit 1 is used only for a test mismatch.

| Code | Meaning |
| --- | --- |
| 0 | Command succeeded; a test reply contains the expectation |
| 1 | Reply received, but the expectation did not match |
| 2 | Run failed/stopped, or a home request/protocol failure |
| 3 | Deadline reached; known admission ids are retained |
| 4 | Usage, pairing/access, bot selection or transcript error |

A failed or stopped run prints its safe final-message reason when available, otherwise a plain
fallback. A transcript failure returns 4 even if the bot reply matched; known admission ids remain
in the result.

## Scopes and revocation

- `bots`, `status`, waits, run/task reads, message reads and `test bot` need **read**.
- `send` and `test bot` need **dispatch**; ordinary work is limited by the grant's **ordinary** authority.
- `stop` needs **stop**.
- Home, space, user and bot policies still apply. Turning dispatch off at home refuses sends.

The CLI does not send presence, approve consequential actions, change permissions, or grant
delegation. Work needing an approval stays waiting until you review it in the app.
A stolen config permits an attacker to sign requests with the **existing grant's scopes**
until you revoke it. Do not assume the set of CLI commands limits what a stolen key can sign.
The separate presence key is not saved, so the config cannot supply that additional presence proof.

To revoke, open **Settings → Devices**, find the device labelled **Command line**, and choose
**Revoke**. Its next request is refused. Removing the local file alone does not revoke the grant.

## Pair, bots and status exit codes

| Code | Meaning |
| --- | --- |
| 0 | Command succeeded |
| 1 | Home unreachable or another request failure |
| 2 | Access refused, revoked grant, changed identity, or unsafe config permissions |
| 3 | Invalid arguments, pairing payload or task input |

A send without `--wait` reports successful admission, not successful task completion.
A stop reports that cancellation was requested, not that it has finished.
Normal process interruption can return the shell's interruption code.

Out of scope: streaming output, webhooks, OAuth sign-in and automatic approval.

## Signed device operations

Existing operations and their wire shapes are unchanged. These operations use the existing
`POST /device/request` envelope `{operation, body, proof}`; all four new reads require read scope.

| Operation | Exact body | Response |
| --- | --- | --- |
| `runs/get` | `{runId}` | `{run: DeviceRunDetail}` |
| `tasks/get` | `{taskId}` | `{task: DeviceRunDetail}` |
| `runs/list` | `{cursor?: runId, limit?: 1..100}` | `{runs: DeviceRunDetail[], nextCursor: runId \| null}` |
| `messages/get` | `{threadId, botId?, groupId?, before?: nonnegative integer, around?: {messageId}}` | Existing `ThreadMessagePage`: `{threadId, messages, olderCursor}` |
| `dispatch` (existing) | `{clientNonce, botId?, text, replyToTaskId?}` | Existing `DispatchReceipt` |
| `stop` (existing) | `{taskId}` | `{cancelRequested:true}` |

A paired device can read messages only in threads of tasks admitted to that device. A thread
without its admission receipt gets the same refusal as an unknown thread. Thread ownership
is checked independently. Message reads require exactly one of botId or groupId. Pages are bounded at 100 and retain the
existing filtering, command hydration and device redaction. Around lookup retrieves a bounded
window around the exact message, not an unbounded transcript.

`DeviceRunDetail` contains the unchanged receipt fields `taskId, runId, threadId, botId,
state, cancelRequested`, plus `status, cancelConfirmed, messageId, failure, createdAt,
startedAt, completedAt`. Message id and start/completion times may be null. Failure is null
or `{category, message}`, using the shared safe failure categories and a fixed plain sentence.
A completed run without a saved answer carries category `other` and the fixed sentence
“The task finished, but its answer is unavailable. Open it at home.”
Raw run status stays separate from dispatch state. Reading a completed record does not prove
that a final answer exists or that the owner accepted it.

### Portable strings and conformance

Pairing payloads and canonical signed JSON accept only well-formed Unicode strings: ordinary
Unicode scalar values, including valid UTF-16 surrogate pairs for characters outside the basic
plane. Lone high or low surrogates in values or keys are refused with
“Use well-formed Unicode strings.” No Unicode normalization is applied. Keys retain the
existing JavaScript UTF-16 sort order. Every client must reproduce the exact canonical bytes.

Synthetic request bodies, canonical JSON and signed text live in
`apps/cli/fixtures/device-operations.json`, including four rejected surrogate vectors.
Regenerate with `pnpm exec tsx apps/cli/generate-device-fixtures.ts`. Contract tests verify
these vectors against the home canonicalizer; they are available to the Rust client for byte-parity checks.

## Protocol references

- [Shared pairing and signature contracts](../packages/contracts/src/dispatch.ts)
- [Device routes and scope checks](../apps/api/src/remote-devices.ts)
- [Node HTTPS API](https://nodejs.org/api/https.html)
- [Windows Set-Acl](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl)
