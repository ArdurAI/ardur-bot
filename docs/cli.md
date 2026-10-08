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
The first home link must be an HTTPS origin reachable from your terminal. The local listener
must be enabled when using a desktop home's network link. Do not expose a listener without
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
`--wait` polls saved tasks and summaries, then reads the summary's final message through the
existing read-only message procedure. It prints answer text, not tool output or reasoning.
`--json` prints one JSON result; errors go to standard error as JSON.

Waiting is not streaming. It checks about every two seconds and each signed request needs a nonce
round trip. Polls read local saved state; they do not start additional model turns. Running the task
still uses the bot's configured model and computer, with their normal costs and approvals.
An individual network request times out after 15 seconds. `send --wait` has no overall deadline; `test bot` has a finite deadline.
Interrupting the CLI stops waiting, **not the task**; use `ardur stop` to request cancellation.

There is no automatic send retry. If a network failure happens after admission, the task may still
be running. Check it at home before repeating a send, or you may create a second task.
`--wait` cannot resume from an id in this release. If a task falls out of the bounded saved list
or its answer is unavailable, the CLI asks you to check it at home.

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

These codes apply only to `test bot`; existing commands keep the codes below.

| Code | Meaning |
| --- | --- |
| 0 | Exact final reply contains the expectation |
| 1 | Reply received, but the expectation did not match |
| 2 | Run failed/stopped, or a home request/protocol failure |
| 3 | Deadline reached; known admission ids are retained |
| 4 | Usage, pairing/access, bot selection or transcript error |

A failed or stopped run prints its safe final-message reason when available, otherwise a plain
fallback. A transcript failure returns 4 even if the bot reply matched; known admission ids remain
in the result.

## Scopes and revocation

- `bots`, `status`, `--wait` and `test bot` need **read**.
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

## Existing command exit codes

| Code | Meaning |
| --- | --- |
| 0 | Command succeeded; with `--wait`, task completed |
| 1 | Task failed/stopped, home unreachable, or another request failure |
| 2 | Access refused, revoked grant, changed identity, or unsafe config permissions |
| 3 | Invalid arguments, pairing payload or task input |

A send without `--wait` reports successful admission, not successful task completion.
A stop reports that cancellation was requested, not that it has finished.
Normal process interruption can return the shell's interruption code.

Out of scope: streaming output, webhooks, OAuth sign-in and automatic approval.

## Protocol references

- [Shared pairing and signature contracts](../packages/contracts/src/dispatch.ts)
- [Device routes and scope checks](../apps/api/src/remote-devices.ts)
- [Node HTTPS API](https://nodejs.org/api/https.html)
- [Windows Set-Acl](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl)
