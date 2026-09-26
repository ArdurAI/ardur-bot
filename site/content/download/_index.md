---
title: "Download"
description: "Every real way to install it today: what exists, and what does not yet."
eyebrow: "Install"
---

There is no signed installer and no published Homebrew tap yet. What exists today is an
**unsigned desktop preview**, a **source checkout**, and a **self-hosted server**. This page says
plainly which is which; nothing here is invented.

## Desktop preview (unsigned)

Download your OS and architecture from
[GitHub pre-releases]({{< repo-link >}}/releases). These builds are **unsigned**; macOS builds
are also **not notarized**. Only approve a download you trust from the official release page.

{{< platform-grid >}}
{{% platform "macOS" %}}
Open the arm64 DMG for Apple Silicon or the x64 DMG for Intel, drag the app into
**Applications**, and eject the DMG. Gatekeeper will say the developer cannot
be verified. Right-click the app &rarr; **Open** &rarr; **Open**,
or use **System Settings &rarr; Privacy & Security &rarr; Open Anyway**.
{{% /platform %}}
{{% platform "Windows" %}}
Run the x64 NSIS installer. SmartScreen may show **"Windows protected your
PC"** and an unknown publisher. Choose **More info &rarr; Run
anyway**. Managed computers may not allow this override.
{{% /platform %}}
{{% platform "Linux" %}}
Download the matching AppImage, `chmod +x` it, and run it. Some distributions
need FUSE support for AppImages. A `.deb` alternative installs with
`apt install ./ardur-bot-*.deb` on Debian/Ubuntu.
{{% /platform %}}
{{< /platform-grid >}}

Updates on unsigned previews are download-only on every OS: the app shows
&ldquo;A new version is available&rdquo; and links to the release page. There is no
in-place automatic update for an unsigned build.

## Homebrew (not published yet)

The release workflow builds a Homebrew cask file and attaches it to each pre-release, but no tap
has been published. Until then, `brew install --cask ardurai/tap/ardur-bot` will not work. See
[Homebrew tap handoff]({{< repo-link "docs/desktop-release.md#homebrew-tap-handoff" >}}) for the
exact two commands that publish it once the tap repository exists.

## Build from source

You need Node.js 22.22.2+ (22.x line), Node.js 24.x, or Node.js 26+; pnpm 9; and Docker.

```sh
git clone {{ .Site.Params.repoURL }}.git
cd ardur-bot
git checkout dev
cp .env.example .env
```

Set `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET` and
`SANDBOX_SUPERVISOR_TOKEN` in `.env`, then:

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
create your first bot. See [Run from source]({{< repo-link "README.md#run-from-source" >}}) for
the complete steps.

## Self-host a server

The signed-in product is a long-running API, a worker, Postgres, and a computer provider — not a
static site. Three real paths exist:

1. **Published images, no checkout.** Pull `ghcr.io/ardurai/ardur-bot/app` and Postgres into an
   empty folder with the installer script. Requires Docker Engine 26+.
2. **Docker Compose from a source checkout.** The same `.env` as above, plus
   `docker compose -f infra/compose/docker-compose.yml up --build`.
3. **Public single-VM deployment.** `infra/compose/docker-compose.prod.yml` runs Postgres, the
   API, worker, web app and automatic HTTPS through Caddy, using E2B for bot computers.

Full steps, secrets checklist, and upgrade/rollback procedures are in
[Self-hosting]({{< repo-link "docs/self-host.md" >}}).

## Mobile

There is no public app store listing yet. The iOS and Android client points at a self-hosted or
desktop-hosted server: on the sign-in screen, choose **Use a custom server** and enter your
server's HTTPS origin. See [Mobile builds and store releases]({{< repo-link "docs/mobile-release.md" >}})
if you want to build and distribute your own branded app.

## What this means today

- If you want the least setup: try a desktop preview, knowing it is unsigned.
- If you want a server others can reach, or you want Docker/Podman/Kubernetes computers: self-host.
- If you want to see or change the code as you run it: build from source.
