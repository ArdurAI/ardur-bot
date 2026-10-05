---
title: "Command-line tool"
description: "Send a bot a task from your terminal or a script. Pair the command line with your home once,"
source_path: "docs/cli.md"
---

> [Source: docs/cli.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/docs/cli.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

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
access explicitly allowed. See [Server device pairing](/docs/self-host-guide/#pair-a-phone-or-command-line-device-with-a-server)
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
`--wait` polls saved tasks and summaries, then reads the summary's final message through the
existing read-only message procedure. It prints answer text, not tool output or reasoning.
`--json` prints one JSON result; errors go to standard error as JSON.

Waiting is not streaming. It checks about every two seconds and each signed request needs a nonce
round trip. Polls read local saved state; they do not start additional model turns. Running the task
still uses the bot's configured model and computer, with their normal costs and approvals.
An individual network request times out after 15 seconds. Waiting has no overall deadline.
Interrupting the CLI stops waiting, **not the task**; use `ardur stop` to request cancellation.

There is no automatic send retry. If a network failure happens after admission, the task may still
be running. Check it at home before repeating a send, or you may create a second task.
`--wait` cannot resume from an id in this release. If a task falls out of the bounded saved list
or its answer is unavailable, the CLI asks you to check it at home.

## Scopes and revocation

- `bots`, `status` and `--wait` need **read**.
- `send` needs **dispatch**; ordinary work is limited by the grant's **ordinary** authority.
- `stop` needs **stop**.
- Home, space, user and bot policies still apply. Turning dispatch off at home refuses sends.

The CLI does not send presence, approve consequential actions, change permissions, or grant
delegation. Work needing an approval stays waiting until you review it in the app.
A stolen config permits an attacker to sign requests with the **existing grant's scopes**
until you revoke it. Do not assume the set of CLI commands limits what a stolen key can sign.
The separate presence key is not saved, so the config cannot supply that additional presence proof.

To revoke, open **Settings → Devices**, find the device labelled **Command line**, and choose
**Revoke**. Its next request is refused. Removing the local file alone does not revoke the grant.

## Exit codes

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

- [Shared pairing and signature contracts](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/packages/contracts/src/dispatch.ts)
- [Device routes and scope checks](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/apps/api/src/remote-devices.ts)
- [Node HTTPS API](https://nodejs.org/api/https.html)
- [Windows Set-Acl](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl)
