# Ardur

Open-source desktop bots that run on your own AI subscriptions and keys.

Ardur gives you named bots that keep their memory, talk to each other in group chats,
run routines on a schedule, use connectors, and ask before doing anything consequential.
Each bot is pinned to a provider, model and effort level you choose: a review bot that
always uses your ChatGPT account at `xhigh` effort, a research bot on Kimi, a local bot on
Ollama. Bots work on computers you control: your machine, Docker, and (planned) Podman and
Kubernetes.

Ardur is an independently maintained fork; see [NOTICE](NOTICE) for its upstream origin and
Apache-2.0 attribution.

> **Status: alpha.** Everything lands on the `dev` branch; `main` moves only after a
> human has verified a build. The release workflow produces unsigned desktop previews;
> check the release assets before choosing an installer. Running from source remains available.

## What you get today

- Persistent bots with their own conversation, memory, routines and history
- Group chats whose members answer at the same time — the owner sets how many bots answer at
  once (1-8) in group settings — and delegation between bots, plus short-lived subagents
- A provider, model and thinking level per bot, with a separate model and thinking choice for each bot in a group room
<!-- site-facts:providers:start -->
<!-- Generated from site/data/product.json by pnpm site:facts; edit that file. -->
- Providers: OpenRouter, OpenAI Codex (ChatGPT account), Anthropic (API key),
  OpenAI, Google, Vercel AI Gateway, and 36 more in the searchable model catalog.
  OpenAI-compatible servers cover local Ollama, LM Studio and llama.cpp.
  Planned additions include Claude Pro/Max through the CLI and Ollama as a direct local choice.
<!-- site-facts:providers:end -->
- Computers: the computer Ardur is installed on, plus Docker, Podman, Kubernetes or SSH
  machines you add, and E2B, Daytona or Box on a server, with a browser, terminal, files and a
  graphical desktop. Test, edit, and remove saved computer connections in Settings
  ([where bots run](docs/self-host.md#where-bots-run)).
- Connectors: MCP servers, OpenAPI documents, Composio, Pipedream Connect
- Approvals before consequential actions, voice mode, and web, Electron desktop and Expo
  mobile clients of the same API

Experimental Antigravity text conversations can run on a connected host computer with an exact model pin; see [Antigravity runtime](docs/antigravity-runtime.md).

Experimental Hermes runs on this computer in desktop local mode and the dev stack, or on a paired macOS or Linux host, with a pinned install. Windows isn't supported; see [Hermes runtime](docs/runtimes/hermes.md).

## Memory

### What is stored where

The built-in database is the default document store. Git repository storage holds a space's shared notes and their revision history; personal and bot-private documents stay in the database. A selected local memory folder can hold space-shared documents and the connected owner's documents.

### Connect a repository

Open Settings → Memory → Memory storage → Manage → Git repository. Connect a dedicated empty repository, supply a repository token or deploy key, and choose its branch. Choose Publish directly to push to that branch, or Propose on a branch to send changes to a proposal branch for review. Test the connection and preview the move before using the location.

### Work offline and resolve conflicts

After setup, a shared-note save creates a local Git commit before background synchronization is queued. If the repository is unreachable, the last local copy remains available while Ardur's server and storage are available. The background worker retries synchronization, and a failed sync offers Retry. When shared edits conflict, Ardur keeps both versions and their revision histories.

### Edit a note in GitHub

After synchronization, shared notes are Markdown files in the connected repository, with revisions in its history. Edit an existing note's body in a Git checkout or on GitHub, keep its frontmatter, and commit the change. Ardur incorporates the edit on its next fetch of that branch.

## Where it is going

- Subscription-honest providers: Claude Pro/Max through your own unmodified `claude` CLI,
  Codex through OpenAI's documented integration, Kimi and Z.ai coding plans, Gemini with an
  API key, Ollama as a first-class choice
- Computers on Podman and kind/Kubernetes
- Signed and notarized downloads
- A fast, smooth UI on Windows, macOS and Linux

Roadmap and questions live in [Discussions](https://github.com/ArdurAI/ardur-bot/discussions).

## Install a desktop preview

Download your OS and architecture from [GitHub pre-releases](https://github.com/ArdurAI/ardur-bot/releases).
These builds are **unsigned**; macOS builds are also **not notarized**. Signed builds come later.
Only approve a download you trust from the official release page.

- **macOS:** open the arm64 DMG for Apple Silicon or x64 DMG for Intel, drag **Ardur.app**
  into **Applications**, and eject the DMG. The ZIP contains the same app for manual installation.
  Gatekeeper can say the developer cannot be verified or the app cannot be checked for malicious
  software. Updates show **“A new version is available — download”**; download the next DMG and
  replace the app manually.
- **Windows:** run the x64 NSIS `.exe`. SmartScreen may show **“Windows protected your PC”**
  and an unknown publisher.
- **Linux:** download the matching AppImage, or the `.deb` on Debian/Ubuntu. Linux commonly
  requires the executable permission rather than displaying a SmartScreen-style publisher prompt.

To open the app the first time:

<!-- site-facts:first-open:start -->
<!-- Generated from site/data/product.json by pnpm site:facts; edit that file. -->
**macOS**

- In Finder, right-click the app, choose “Open”, then choose “Open” again.
- If macOS doesn't offer “Open”, try to open the app once, then go to “System Settings”, then “Privacy & Security”, and choose “Open Anyway”.
- Enter your password when asked, then choose “Open”.
- Or remove the download's quarantine flag in Terminal.

  ```sh
  xattr -d com.apple.quarantine "/Applications/Ardur.app"
  ```
- Then open the app.

  ```sh
  open "/Applications/Ardur.app"
  ```

**Windows**

- If “Windows protected your PC” appears, choose “More info”, then “Run anyway”.
- Finish the installer.

**Linux**

- Make the AppImage executable, then open it.

  ```sh
  chmod +x ./ardur-*.AppImage
  ```
- On Debian or Ubuntu, you can install the deb instead.

  ```sh
  sudo apt install ./ardur-*.deb
  ```
- After installing the deb, check that it runs.

  ```sh
  ardur --version
  ```
<!-- site-facts:first-open:end -->

Approving quarantine does not add a developer signature or notarization. Managed Windows
computers may disallow the SmartScreen override, and no trusted publisher identity is asserted.
Some Linux distributions require FUSE support for AppImages, and a standalone deb has no
distribution-repository trust guarantee.

**This computer** starts the app's own database and services. Docker is not required for that
first launch. You can still connect the client to an existing server. See
[what commands can do on this computer](docs/self-host.md#what-commands-can-do-on-this-computer).
For bounded coordinator work in a group, see [team goals](docs/goals.md).
Docker remains available later as an added computer, and Compose remains the way
to run a server. Unsigned previews use manual downloads for updates on every OS.

Install the same preview with [Homebrew](docs/desktop-release.md#homebrew-tap-handoff):

```sh
brew tap ArdurAI/tap
brew trust --cask ArdurAI/tap/ardur
brew install --cask ArdurAI/tap/ardur
```

Current Homebrew requires the trust step before it loads a third-party cask; Homebrew releases
without the trust command can skip it. Previews are unsigned and not notarized; approve the app
once in Privacy & Security. The cask does not bypass macOS quarantine. See
[desktop releases](docs/desktop-release.md) for build and acceptance instructions.

## Run from source

<!-- site-facts:from-source:start -->
<!-- Generated from site/data/product.json by pnpm site:facts; edit that file. -->
You need Node.js 22.22.2 or newer in the 22.x line,
Node.js 24.x, or Node.js 26+; pnpm 9; and Docker. Node.js 23.x and 25.x are not supported.

```sh
git clone https://github.com/ArdurAI/ardur-bot.git
cd ardur-bot
cp .env.example .env
```

In `.env`, set `POSTGRES_PASSWORD` to a random value (for example, `openssl rand -hex 16`)
and put the same value in `DATABASE_URL`.
Set `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`
and `SANDBOX_SUPERVISOR_TOKEN` to separate long random values (for example, `openssl rand -hex 32`).
Add model credentials in the app or set `OPENROUTER_API_KEY`.

```sh
docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.postgres-host.yml \
  up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```
<!-- site-facts:from-source:end -->

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), create an account, connect a model, and
create your first bot. Local Docker computers are on by default.
The first Docker bot downloads its computer image when no local build exists. The organization
owner must make the GHCR computer package public for that download; `pnpm build:computers`
builds a local fallback.

Postgres stays network-internal in the default Compose file; the `postgres-host` overlay
publishes loopback `127.0.0.1:5433` for host-side `pnpm` and database tools. `docker compose
down -v` deletes all Postgres state.

## Desktop app

The Electron app is a client of the same API as the web app. With the development stack
running:

```sh
pnpm --filter @ardurbot/desktop dev
```

On first run it starts its own database and services on this computer; its setup window can
connect it to an existing server instead.

## Development

```sh
pnpm check   # TypeScript across the monorepo
pnpm lint    # Biome lint and format
pnpm test    # offline unit tests, no keys needed
```

More checks and the branch policy are in [CONTRIBUTING.md](CONTRIBUTING.md). Design notes
are under [docs/](docs/) where present and decisions under [docs/decisions/](docs/decisions/).

## Community

- Website: [bot.ardur.ai](https://bot.ardur.ai)
- Bugs and feature requests: [Issues](https://github.com/ArdurAI/ardur-bot/issues)
- Questions, ideas, roadmap: [Discussions](https://github.com/ArdurAI/ardur-bot/discussions)
- Security reports: [SECURITY.md](SECURITY.md)

## License

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
