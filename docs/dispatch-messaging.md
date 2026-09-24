# Dispatch over chat

Telegram, Discord and Slack can send work to a running home without an inbound public port.
The home and worker must stay awake. Execution keeps the bot's selected model and computer.
Messaging providers receive channel content; this optional feature does not make them necessary
for the rest of the product.

## Owner verification

1. Apply the additive database migration with `pnpm db:migrate`, then start the API, worker and
   web application. A development checkout can use `pnpm dev`. Sign in as the home owner.
2. Create a Telegram test bot with BotFather. Keep its token in Settings. Use a new test bot with
   no registered webhook, or remove its existing webhook through Telegram before enabling polling.
   The laptop can remain behind NAT; no router port forwarding is needed.
3. Open Settings → Devices → Pair a chat account. Choose Telegram, select the Ardur bot, and
   enter the test bot token. Choose Get pairing code. No webhook secret is required for polling.
4. From your own Telegram account, send the code to that test bot in a **private** message within
   five minutes. Expect “Paired.” and a new Telegram account entry beside the phones in Devices.
   A group message cannot redeem the code. A second account must obtain its own code at home.
5. Send an ordinary research question. Expect “Accepted — working on it.” only after admission.
   Reply to that receipt to steer the same task. Send a separate message to create another task.
   Expect one final summary; a long task may send one “Still working.” notice after three minutes.
6. Reply `stop` to a task receipt. Expect “Stop requested.”, then “Stopped.” only when the executor
   confirms that the task and its delegated work have stopped. Already completed effects remain.
7. At home, configure an approval rule requiring approval for an ordinary built-in tool such as
   `read_file` through the authenticated `approvalRules.set` RPC (see the test setup below). Ask the test bot to read a harmless test file. Its bound approval card contains
   the preview, the action and Cancel. Tap the action once; a repeated click cannot authorize a
   second effect. A changed request or expired card must be reviewed again at home.
8. Request a consequential action, such as a shell command. Expect “Approve this on your Mac or
   phone.” Chat cannot grant consequential scope, prove device presence, change permissions,
   enroll connectors or request persistent approval. Continue from the authenticated home or an
   enrolled device under P1's existing policy. The channel grant never gains consequential
   scope: perform work outside its ceiling as a separate, explicitly reviewed home/device task.
   Open shared-room transcripts from Activity at home; personal DM tasks appear in the bot thread.
9. Restart the worker and replay an inbound fixture/event. Verify that the same task receipt is
   returned, Telegram's offset is retained, and an existing result keeps its original destination.
   Revoke the Telegram account in Devices and confirm its next request runs nothing.
10. Use harmless placeholders to check rejection: `password=placeholder` must produce “Add secrets
    in Settings, not in chat.” The inbox and outbox must contain no pasted value. Never test with
    real credentials.

Discord uses a bot token and the configured server/guild ID. Enable the Message Content intent
for the bot, allow it to receive DMs, and pair in a DM. The grant remains isolated to the configured
server; joining another server does not authorize that workspace. Gateway Identify, heartbeats,
Resume and reconnect run in the worker. No interaction webhook is required.

Slack uses a bot token, an app-level token with `connections:write`, and the team ID. Enable Socket
Mode, subscribe to the message/app-mention events required by your chosen conversations, enable
interactivity, and grant `chat:write` plus the history scopes for those conversations. Pair in a DM.
Socket envelopes are acknowledged after durable receipt. Approval buttons use Block Kit.

For the low-risk approval test, use the authenticated home web session to call the existing
`approvalRules.set` RPC with this input. The current Settings UI exposes category presets;
it does not yet have a tool-name rule editor. Remove the test rule afterwards through Settings.

```json
{ "effect": "require_approval", "matchKind": "tool", "matchValue": "read_file" }
```

## Implementation decisions

- A channel is a `DeviceGrant` with `kind = channel`. Its installation, provider, workspace and
  immutable sender ID form its identity. Display names and membership are not authority.
- `admitDispatch` remains the only task admission path. Its transaction commits the receipt,
  task origin and Accepted outbox entry. Explicit replies target the existing task and bot.
- Personal DMs use the authorized bot thread shared with home and phones. Shared-room tasks
  create an `ExternalConversation` with isolated history; Activity opens that room transcript
  through an ownership-checked thread target. Legacy mirroring excludes all Dispatch runs.
  Native mobile currently projects personal bot threads only; review shared-room tasks in the
  home web Activity view (also available in a phone browser on the home network).
- `DeviceApprovalBinding` remains the once-only approval authority. Built-in approvals bind
  their bot resource and revision as well as exact arguments. The channel ceiling is enforced
  again before execution; unknown risks remain consequential.
- One elected worker owns receivers and delivery across installations. Loss of its PostgreSQL
  advisory-lock connection aborts the sockets immediately. Inbox and WebSocket queues have
  limits of 256 and 64 events; a grant admits at most 12 requests per minute and 20 active tasks.
- The outbox has a 256-entry pending bound per installation and records progress per sent chunk.
  Explicit rate-limit rejection schedules a retry. Network ambiguity becomes `uncertain`,
  including a process crash during sending. It is never automatically resent. Exactly-once
  delivery cannot be guaranteed when the provider does not offer an idempotent send operation.
- Recognizable credentials and configured transport credentials are rejected before inboxing.
  Text attachments are inspected before persistence, capped at three files and 256 KB combined,
  with at most 24,000 characters per file and 32,000 characters including the message. Binary,
  unsupported or oversized attachments stay at home. Text and filenames are escaped as peer data.
- Configuration secrets use the existing encrypted secret store. Audit events contain IDs and
  outcomes, never message text, pairing codes or credentials. Pairing codes are hashed, single-use,
  expire after five minutes, and share P1's home-wide attempt throttle.
- Telegram's existing webhook URL is retained. Installations using it must configure a webhook
  URL and secret; polling never competes with a registered webhook. Binary/file ingestion on the
  webhook path remains refused. Long-poll and socket transports can inspect supported text files.

The operator sees pairing, plain receipts and quiet results. The builder gets outbound connections,
inspectable durable records and unchanged execution pins. The researcher gets retry-safe tasks and
stable results. The team lead gets independent grants, revocation and metadata audits. The local-first
user keeps execution at home and explicitly opts into each external messaging service.

No new runtime dependency is introduced. Transports use Node's `fetch` and `WebSocket`.

## Protocol references

- [Telegram Bot API: getUpdates](https://core.telegram.org/bots/api#getupdates)
- [Discord Gateway](https://docs.discord.com/developers/events/gateway)
- [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)

## Merge notes

The design baseline is an ancestor of this branch. This implementation extends P1's grant,
receipt, approval and cancellation paths. The migration is additive. Router and worker entry
points only compose services; protocol code lives under `packages/adapters/src/messaging`.
The executor's small hook binds remote built-ins through its existing approval envelope.
Review conflicts around `admitDispatch`, `DeviceGrant`, the passive Telegram registration,
`DevicesSettings`, and the P1 approval helper. Keep the isolated task origin when changing routes.
Legacy environment-only Telegram polling moves to the worker's installation configuration;
connect and pair that bot through Devices. Signed legacy webhook delivery remains available.

The web E2E fixtures capture the expanded Devices pairing screen as
`settings-devices-pairing` and the room review as `dispatch-room-review`.
Run them in CI and attach those artifacts when a PR is created. Live-account
checks, database deployment and the desktop Playwright suite are separate from offline verification.
