# Ardur Bot

Open-source desktop bots that run on your own AI subscriptions and keys.

Ardur Bot gives you named bots that keep their memory, talk to each other in group chats,
run routines on a schedule, use connectors, and ask before doing anything consequential.
Each bot is pinned to a provider, model and effort level you choose: a review bot that
always uses your ChatGPT account at `xhigh` effort, a research bot on Kimi, a local bot on
Ollama. Bots work on computers you control: your machine, Docker, and (planned) Podman and
Kubernetes.

Ardur Bot is a fork of [Rakazo](https://github.com/elie222/rakazo) (Apache-2.0). See
[NOTICE](NOTICE) and [ADR-001](docs/decisions/ADR-001-fork-and-rename.md).

> **Status: pre-alpha.** Everything lands on the `dev` branch; `main` moves only after a
> human has verified a build. The release workflow produces unsigned desktop previews;
> check the release assets before choosing an installer. Running from source remains available.

## What you get today

Inherited from Rakazo and working:

- Persistent bots with their own conversation, memory, routines and history
- Group chats and delegation between bots, plus short-lived subagents
- A provider, model and thinking level per bot
- Providers: OpenRouter, OpenAI Codex (ChatGPT account), Anthropic (API key), OpenAI,
  Google, Vercel AI Gateway, and any OpenAI-compatible server, which covers Kimi Code,
  Z.ai, and local Ollama, LM Studio or llama.cpp
- Computers: this computer from the installed desktop app, plus Docker, E2B, Daytona, or Box,
  with a browser, terminal, files and a graphical desktop
- Connectors: MCP servers, OpenAPI documents, Composio, Pipedream Connect
- Approvals before consequential actions, voice mode, and web, Electron desktop and Expo
  mobile clients of the same API

## Where it is going

- Subscription-honest providers: Claude Pro/Max through your own unmodified `claude` CLI
  (the inherited Claude.ai OAuth login will be removed, since Anthropic's terms do not allow
  third-party apps to use it), Codex through OpenAI's documented integration, Kimi and Z.ai
  coding plans, Gemini with an API key, Ollama as a first-class choice
- Computers on Podman and kind/Kubernetes
- Download and Homebrew install
- A fast, smooth UI on Windows, macOS and Linux

Roadmap and questions live in [Discussions](https://github.com/ArdurAI/ardur-bot/discussions).

## Install a desktop preview

Download your OS and architecture from [GitHub pre-releases](https://github.com/ArdurAI/ardur-bot/releases).
These builds are **unsigned**; macOS builds are also **not notarized**. Signed builds come later.
Only approve a download you trust from the official release page.

- **macOS:** open the arm64 DMG for Apple Silicon or x64 DMG for Intel, drag **Ardur Bot.app**
  into **Applications**, and eject the DMG. Gatekeeper can say the developer cannot be verified
  or the app cannot be checked for malicious software. In Finder, right-click → **Open** →
  **Open**. On recent macOS versions where that override is unavailable, attempt to open once,
  then use **System Settings → Privacy & Security → Open Anyway**, authenticate, and click
  **Open**. A terminal alternative for that downloaded app is:

  ```sh
  xattr -d com.apple.quarantine "/Applications/Ardur Bot.app"
  open "/Applications/Ardur Bot.app"
  ```

  The ZIP contains the same app for manual installation. Approving quarantine does not add a
  developer signature or notarization. Updates show **“A new version is available — download”**;
  download the next DMG and replace the app manually.
- **Windows:** run the x64 NSIS `.exe`. SmartScreen may show **“Windows protected your PC”**
  and an unknown publisher. Choose **More info → Run anyway**, then finish the installer.
  Managed computers may disallow this override. No trusted publisher identity is asserted.
- **Linux:** download the matching AppImage, then run:

  ```sh
  chmod +x ./ardur-bot-*.AppImage
  ./ardur-bot-0.1.0-alpha.1-linux-x64.AppImage
  ```

  Substitute your downloaded version and architecture. Linux commonly requires the executable
  permission rather than displaying a SmartScreen-style publisher prompt. Some distributions
  require FUSE support for AppImages. On Debian/Ubuntu, the `.deb` alternative installs with
  `sudo apt install ./ardur-bot-*.deb`; a standalone deb has no distribution-repository trust
  guarantee. Run `ardur-bot --version` after installing it.

**This computer** starts the app's own database and services. Docker is not required for that
first launch. You can still connect the client to an existing server. On this computer, approvals,
folder allowlists, and secret redaction are enforced. Disk, CPU, and time caps are advisory, and
the app says so. Docker remains available later as an added computer, and Compose remains the way
to run a server. Unsigned previews use manual downloads for updates on every OS.

After the owner publishes the [Homebrew tap](docs/desktop-release.md#homebrew-tap-handoff):

```sh
brew install --cask ardurai/tap/ardur-bot
ardur-bot --version
```

The cask does not bypass macOS quarantine. The tap is a separate publication step; no existing
tap or published release is assumed by this checkout. See [desktop releases](docs/desktop-release.md)
for build and acceptance instructions.

## Run from source

You need Node.js 22.22.2 or newer in the 22.x line, Node.js 24.x, or Node.js 26+; pnpm 9;
and Docker. Node.js 23.x and 25.x are not supported.

```sh
git clone https://github.com/ArdurAI/ardur-bot.git
cd ardur-bot
git checkout dev
cp .env.example .env
```

In `.env`, set `POSTGRES_PASSWORD` (for example `openssl rand -hex 16`) and put the same
value in `DATABASE_URL`. Set `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`
and `SANDBOX_SUPERVISOR_TOKEN` to separate long random values (`openssl rand -hex 32`).
Model credentials are added in the app, or set `OPENROUTER_API_KEY` here.

```sh
docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.postgres-host.yml \
  up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), create an account, connect a model, and
create your first bot. Local Docker computers are on by default.

Postgres stays network-internal in the default Compose file; the `postgres-host` overlay
publishes loopback `127.0.0.1:5433` for host-side `pnpm` and database tools. `docker compose
down -v` deletes all Postgres state.

## Desktop app

The Electron app is a client of the same API as the web app. With the development stack
running:

```sh
pnpm --filter @ardurbot/desktop dev
```

On first run it asks whether to run the backend on this computer (needs Docker) or connect
to an existing server.

## Development

```sh
pnpm check   # TypeScript across the monorepo
pnpm lint    # Biome lint and format
pnpm test    # offline unit tests, no keys needed
```

More checks, the branch policy and how to sync with upstream Rakazo are in
[CONTRIBUTING.md](CONTRIBUTING.md). Design notes are under [docs/](docs/) where
present and decisions under [docs/decisions/](docs/decisions/).

## Community

- Bugs and feature requests: [Issues](https://github.com/ArdurAI/ardur-bot/issues)
- Questions, ideas, roadmap: [Discussions](https://github.com/ArdurAI/ardur-bot/discussions)
- Security reports: [SECURITY.md](SECURITY.md)

## License

Apache-2.0. Derived from Rakazo; see [NOTICE](NOTICE).
