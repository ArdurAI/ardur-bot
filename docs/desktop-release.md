# Desktop pre-releases

macOS previews have two paths: **Open Anyway** without an identified developer, or a signed and
notarized release when credentials exist. Windows previews remain unsigned.
Work lands on `dev`; `main` moves only after a human verifies a build. CI quality
and performance checks are advisory. Packaging and installed-app acceptance must finish before
an artifact can be published.

## Development phone pairing

For phone pairing against `pnpm dev`, export the same `ARDURBOT_DESKTOP_STACK_TOKEN`
in the shells that start the server and the unpackaged desktop app. Generate it once
with `openssl rand -hex 32`; keep the value private and out of tracked files. Restart
both processes after setting it. Start the server with `pnpm dev`, then the desktop
with `ARDURBOT_WEB_URL=http://127.0.0.1:5173 pnpm --filter @ardurbot/desktop dev`.
Use Settings → Devices to enable network reachability and pair the phone. The
development exception requires a loopback target and is disabled in packaged builds.
For a source or headless server, prefer the operator-enabled listener described in
[Self-hosted device pairing](self-host.md#pair-a-phone-or-command-line-device-with-a-server):
set `ARDURBOT_DEVICE_LISTENER_ENABLED=true`, configure an advertised HTTPS origin,
and optionally configure the bind address and port (defaults: `127.0.0.1`, `43119`).
Packaged existing-instance connections use that server listener when enabled.
The desktop-local listener still requires an app-managed "This computer" home;
only the unpackaged loopback exception above can retrieve development key material.
Keep the server database and `ENCRYPTION_KEY` to preserve its certificate across restarts.
Expose the device port only through a private network/firewall; a TLS-terminating
proxy with another certificate cannot satisfy the home pin.
The listener exposes only the device API over TLS on the private
network; it does not forward cookies, general RPC, or the stack token to phones.

## Native Codex compatibility

Codex owns its ChatGPT sign-in. Native pins use `native:codex-app-server` and never
load a hosted model connection's key or OAuth material. An explicitly selected
hosted connection is refused. Restart the source worker and desktop after changing
runtime code; an already running bundle does not pick up these changes.

Codex CLI 0.156.1 was verified with `initialize`, `account/read`, and `model/list`.
Its generated app-server schema also contains the `thread/start`, `thread/resume`,
`turn/start`, `turn/interrupt`, `turn/steer`, `config/read`, and `skills/list` APIs
used here. There is no numeric version gate; the availability probe checks the
protocol and preserves the version and sign-in result. A missing method or invalid
protocol parameters report an unsupported version; a transport failure reports
that Codex could not be reached.

The [official app-server documentation](https://developers.openai.com/codex/app-server/)
describes the stdio handshake and the version-specific
`codex app-server generate-json-schema --out <directory>` command. Protocol and
credential regressions run offline; actual model execution still requires the
selected model and effort to be returned by the installed CLI.

## Build contract

A `v*` tag push runs `.github/workflows/release-desktop.yml` with publication enabled, as before.
Manual dispatch uses the selected branch or tag and defaults `publish` to **false**. A branch gets
`0.0.0-branch.<short sha>` in the disposable build checkout, without changing its committed version
or requiring ancestry on `dev`. A tag must still match the **root** `package.json` version and point
to a commit on `dev`. Manual publication requires both `publish=true` and a selected tag; a branch
never publishes, even when that input is true. Neither route moves `main` or overwrites an existing
release. Publication requires validated
[performance evidence](performance.md#evidence-index); only a dispatch with a waiver reason can
publish without it, and a tag push cannot. Non-publishing dispatches skip performance evidence and
publication, not packaging or install acceptance.

### Check a branch without publishing

Open **Actions → release-desktop → Run workflow → this branch**, leave **publish** unchecked, and
run the workflow. For this change select `fix/install-acceptance`. The equivalent command is:

```sh
gh workflow run release-desktop.yml --ref fix/install-acceptance -f publish=false
```

All platform build and install-acceptance jobs run with the same scripts and matrix as a tag.
Download installers from `desktop-<platform>-<arch>` and logs/screenshots from
`install-acceptance-<platform>-<arch>` on the run page. Diagnostic uploads run even after acceptance
fails. Successful acceptance also uploads the hash-bound receipts. No release or tag is created.

| Platform | Architecture | Release assets |
| --- | --- | --- |
| macOS | arm64, x64 | DMG and ZIP for each architecture |
| Linux | x64, arm64 on the native ARM runner when supported | AppImage and deb |
| Windows | x64 | NSIS installer |

Builds run separately, so macOS update metadata is merged before publication; neither architecture
can overwrite the other's ZIP entry. Each feed's version and referenced assets are checked. Only
installers, blockmaps, channel feeds, and the generated cask are attached to a GitHub **pre-release**.
It is never marked latest. The application feed remains `ArdurAI/ardur-bot`.

The desktop build bundles the SQL migrator into `dist/db-migrate.js` with only `pg` left
external, so `app.asar` carries neither the database package nor Prisma; the API and worker
bundles under `services` carry their own Prisma runtime.

Every electron-builder run (the release job, `pack`, and `pack:dir`) stages the Postgres binaries
for the platform and architecture it packs through the `beforePack` hook in
`apps/desktop/scripts/stage-embedded-postgres.mjs`. It clears any earlier `build/postgres-modules`
first, keeps the package's library links relative, and fails the build when that platform's
package is not installed. `pack` builds for the computer it runs on.

The root version is the sole editable input. `scripts/desktop-version.mjs` copies it into the
desktop package before every desktop build; that package field is derived packaging metadata.
The executable's `--version` flag prints `app.getVersion()` and exits before taking the instance
lock, opening a window, checking updates, or starting the embedded Postgres server. With the Homebrew cask or Linux deb,
run `ardur --version`; from a DMG install run the bundle executable with `--version`.

Release notes count commits since the previous reachable `v*` tag (all ancestors for the first
release), grouped by `feat`, `fix`, `perf`, `docs`, `build`, `ci`, `test`, `refactor`, `chore`, `style`,
and `revert`. Fixed labels and counts prevent commit subjects, scopes, author names, and file paths
from leaking into generated notes. This deliberately trades detailed changelog prose for safe,
repeatable publication.

## macOS signing, first open, and updates

This repository pins electron-builder **26.15.3** and electron-updater **6.8.9**. The workflow sets
`CSC_IDENTITY_AUTO_DISCOVERY=false` for previews without a certificate. The builder uses its
documented `mac.identity="-"` ad-hoc option, `mac.hardenedRuntime=false`, and `mac.notarize=false`.
After resources and Electron fuses are final, the `afterSign` hook reseals the whole bundle with
`codesign --force --deep --sign - --timestamp=none`, then runs `codesign --verify --deep --strict`.
A signing or verification error fails the build. This includes Electron helpers, embedded
Postgres, native service modules, and the bundled host service's resources.
Windows retains executable icons and version metadata with `win.signExecutable=false`.

For a preview without an identified developer, try to open Ardur once. Open **System Settings >
Privacy & Security**, scroll to the message about Ardur, and choose **Open Anyway**. Or remove the
download flag in Terminal:

```sh
xattr -dr com.apple.quarantine /Applications/Ardur.app
```

The macOS install script removes that flag after copying the app. This does not identify the
developer or notarize the app; only approve a download you trust from the official release page.

When all five repository secrets are present — `MAC_CERTIFICATE_P12` (base64),
`MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` — the
workflow selects the signed path once. Each macOS job imports Developer ID into a temporary
keychain, enables hardened runtime and Electron entitlements through
`apps/desktop/scripts/signed-mac-config.mjs`, and notarizes using electron-builder's Apple ID
environment. Cleanup deletes the temporary keychain even after failure. Failed signing or
notarization does not fall back to a preview. Missing credentials keep the no-account path.
Linux and Windows jobs never receive these credentials.

Signed release notes say **“Signed and notarized for macOS.”** Open these builds normally.
The publication artifact and release include `signing.json` with `signed: true` or `signed: false`;
this describes macOS only, not Windows. The performance gate remains independent of signing.

The documented environment switch disables signing discovery. In this pinned release, the
explicit notarization switch is the **configuration option** `mac.notarize=false`; there is no
verified separate notarization-skip environment flag to add. See the official
[macOS signing options](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/),
[macOS notarization option](https://www.electron.build/v26/docs/mac/), and
[Windows signing option](https://www.electron.build/v26/docs/api/app-builder-lib.interface.windowsconfiguration/).

Unsigned macOS apps cannot apply electron-updater updates automatically; its
[auto-update documentation](https://www.electron.build/v26/docs/features/auto-update/) requires
code signing. All previews, including signed ones, use download-only updates on all desktop platforms, so the
UI never claims a verified in-place installation. On discovery it shows **“A new version is
available — download”**, linking to the official release page. This copy appears only when a new
version exists; removing it would leave users without an update action. “Open Ardur” and “Quit”
are the tray actions, necessary to reopen or leave the background app.

`autoDownload` and `autoInstallOnAppQuit` remain off for preview installs, pre-release discovery is
on, and downgrade checks remain disabled. Windows signature verification is retained for a future
signed channel; it is not bypassed to make an unsigned automatic update appear verified.
Enabling signed builds does not change this update policy.

## Cut a preview

1. Land and review the changes on `dev`. Set the root version to `0.1.0-alpha.1`, run
   `node scripts/desktop-version.mjs`, and include the derived desktop metadata in that change.
2. Build and verify the app locally where possible. Push the approved `dev` revision, then tag it:

   ```sh
   git tag v0.1.0-alpha.1
   git push origin v0.1.0-alpha.1
   ```

   A tag push publishes only with validated performance evidence. No job produces that evidence
   yet, so this run currently stops at the evidence gate.

3. Until the physical evidence runner exists, dispatch the workflow on the existing tag with
   `publish=true` and a waiver reason. The reason is recorded with the dispatching account and printed in the
   release notes:

   ```sh
   gh workflow run release-desktop.yml --ref v0.1.0-alpha.1 -f publish=true \
     -f evidence_waiver="Physical release runners are not provisioned"
   ```

4. Wait for the pre-release assets. Download the DMG matching the Mac architecture, drag
   **Ardur.app** to **Applications**, eject the DMG, and follow the unsigned-opening steps
   in the [README](../README.md#install-a-desktop-preview). Open it, confirm the version in update
   settings, and complete setup. **This computer** starts the app's own database and services; see
   [what commands can do on this computer](self-host.md#what-commands-can-do-on-this-computer).
   Connecting to an existing server is
   unchanged. On Windows, stopping that database uses the embedded Postgres library's forced
   process-tree kill, and the next start uses Postgres crash recovery.
5. Verify a real installed build before deciding whether `main` should move. Create a bot and
   check that it works on this computer without being asked where bots should run, and that
   **Settings → Computers** shows this computer with its free memory, CPU and disk. See
   [where bots run](self-host.md#where-bots-run) for an app that already runs a Compose stack.
   Do not retag a published version; create a new version for fixes.

For an unsigned host directory build:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @ardurbot/desktop pack:dir
```

`ARDURBOT_USER_DATA_DIR` overrides Electron's user-data directory for a packaged or
unpackaged launch. Point it at an empty temporary directory when checking a packaged
build so the app does not write into the default profile. `ARDURBOT_PERFORMANCE_USER_DATA`
is still used when `ARDURBOT_USER_DATA_DIR` is unset.
The display-name change keeps the existing desktop app ID and its previous user-data folder,
so an installed build reads the same setup, database, and files after upgrading.

`--dir` validates and packages an unpacked app; it does not exercise DMG mounting, quarantine,
NSIS installation, or deb dependencies. The desktop Playwright suite belongs in CI, where it
runs in a virtual display.

## Install acceptance

`install-acceptance` downloads each build on a fresh runner before publication. Required entries
are macOS arm64 and x64, Linux x64, and Windows x64. Linux arm64 retains the build matrix's
optional status: if it fails installation, its installers and update feed are omitted, not published.
An evidence waiver cannot bypass installation checks.

- **macOS (`macos-15` arm64, `macos-15-intel` x64)**: quarantine a copy of the DMG as a Safari download, mount it, copy the
  app into temporary Applications, and verify the quarantine attribute. The bundle must pass
  deep, strict codesign verification. Gatekeeper must accept a signed, notarized build; an
  ad-hoc preview must return `rejected` (some macOS versions omit the source line), never damaged or
  missing resources. The signing decision comes from the build's `install-build-mac-<arch>.json`.
  Remove quarantine to model Open Anyway, then open the installed bundle. Render the shipped
  cask template with the local DMG URL and real checksum into a unique temporary local tap,
  install its fully qualified cask into temporary Applications, remove that copy's quarantine,
  run the Homebrew `ardur` wrapper, and uninstall. The wrapper executes the bundle's real path
  rather than a symlink, so Electron can locate its helpers. Cleanup removes the temporary tap;
  no existing tap is changed. Both CI architectures execute natively, with unchanged readiness budgets.
- **Linux (`ubuntu-24.04`, native ARM runner when available)**: each format runs in its own
  fresh `ubuntu:24.04` container. Install the deb with apt, including dependencies; install the
  AppImage as an executable. Launch as a non-root user under Xvfb and a session bus. Probe user
  namespaces: use `--no-sandbox` only if the container denies them and record that reason.
  Use `--appimage-extract-and-run` only when FUSE is unavailable, also recording why.
- **Windows (`windows-2022`)**: silently install NSIS with `/S /D=<temporary directory>`;
  `/D=` is last and unquoted, including when the path has spaces. Open the installed `Ardur.exe`,
  reject crashes/nonzero exits or blocking dialogs, and run the generated uninstaller silently.
  Existing Ardur processes or registered installations cause a hand-run check to refuse instead
  of replacing them. Windows desktop acceptance runs on the fresh runner, not in a container.
  CI creates a temporary standard user with a masked cryptographically random password, loads
  its profile, and runs installation and launch with that user's credential because PostgreSQL
  refuses an administrative token. The acceptance script rejects elevation before installation;
  launches remain bounded and the wrapper checks the owned process's exit status. An always-run
  cleanup removes the temporary user and profile. Manual runs must also be non-elevated.
  Windows acceptance remains visible on every release but is advisory on the administrative
  hosted runner. Silent installation and uninstallation passed; first-launch health/window/clean-exit
  acceptance is still pending. Generated release notes state that limitation explicitly.

Every launch sets `ARDUR_INSTALL_SMOKE=1`, disables update discovery and uses a fresh
`ARDURBOT_USER_DATA_DIR`. The app sets Electron's user-data path before requesting the single-instance
lock, so the fresh profile has its own lock rather than activating a running normal instance. A
refused smoke lock exits nonzero and explains why on stderr. Only this opt-in path starts the app-managed local stack, requires its
real health response and a loaded main window, captures a screenshot, stops its owned services,
and prints `ARDUR_INSTALL_SMOKE_PASS` before quitting. A zero exit without that marker does not
pass. A small JavaScript entry installs the 150-second watchdog before loading the main module;
import failures exit nonzero without waiting for a native error dialog. Stages are written to stderr
through runtime installation, service startup, health, window loading, screenshot capture and
cleanup. A timeout names the current stage, including a stalled quit. The script's launch bound is
180 seconds. This is stricter
than merely surviving 15 seconds. Crash lines in either output stream fail acceptance.
The pinned embedded-postgres dependency's exit hook emits `TypeError: done is not a function`.
The Mac predicate records that exact rejection as a known warning only after a success marker,
zero exit and clean crash checks; other rejection messages still fail. The original stderr is retained.
Normal startup is unchanged; no hosted service or model credentials are needed.

Successful jobs upload hash-bound `install-approved-*` receipts. Before performance gating,
the publication assembly checks their commit, version, signing decision and exact installer
hashes. Required missing or mismatched receipts fail closed. Only Windows may publish without
an install receipt while its check is advisory; no accepted receipt is fabricated. Optional missing ARM receipts
remove that build's files. The publication artifact retains `install-acceptance.json`; each
platform separately uploads stdout, stderr, PASS/FAIL summaries and any screenshots as
`install-acceptance-<platform>-<arch>`.

From this repository checkout, against files already downloaded:

```sh
bash scripts/release/install-acceptance-mac.sh /path/to/ardur-<version>-mac-arm64.dmg
bash scripts/release/install-acceptance-linux.sh /path/to/ardur-<version>-linux-amd64.deb
bash scripts/release/install-acceptance-linux.sh /path/to/ardur-<version>-linux-x86_64.AppImage
pwsh -File scripts/release/install-acceptance-win.ps1 C:\path\to\ardur-<version>-win-x64.exe
```

The Mac script needs Python 3, Homebrew, and the shipped cask template in this checkout. It
refuses an existing Homebrew Ardur cask or command. Linux needs a running Docker daemon and
network access for the public base image and Ubuntu packages. Windows needs PowerShell 7.
Set `ARDUR_INSTALL_LOG_DIR` to retain diagnostics in a chosen directory; otherwise each script
prints its temporary log location. Temporary installs/profiles are removed, not the source artifact.
On a manual Mac run without a build record, the signature is inspected and that limitation is
reported. CI requires the record. An older unsealed download must fail, not become an exception.

The Mac script also accepts an unpacked `Ardur.app` from `pack:dir`. This checks the seal,
Gatekeeper and bundle launch, but explicitly skips DMG and Homebrew checks; it is only a
directory-build diagnostic, not full install acceptance. A local run that forbids databases,
desktop launches or downloads cannot verify this health-based path; use CI or a permitted clean
machine and report the unrun checks rather than claiming success.

## Homebrew tap handoff

The tap is [`ArdurAI/homebrew-tap`](https://github.com/ArdurAI/homebrew-tap) (tap name
`ArdurAI/tap`), shared with other ArdurAI packages; the Ardur cask lives at `Casks/ardur.rb`
there. `homebrew/Casks/ardur.rb` in this repository stays the template: the release workflow
fills its version, architecture-specific DMG URLs, and SHA-256 values from the built files and
attaches `ardur.rb` to the pre-release. It never contacts a tap or makes a repository commit.

The cask uses `command_wrapper` because a symlink to the Electron binary breaks helper lookup,
and requires Homebrew from 2026-09-20 or later (run `brew update` first on older installs).

Each release updates the cask through a reviewed pull request. In a checkout of
`ArdurAI/homebrew-tap`:

```sh
gh release download v0.1.0-alpha.2 --repo ArdurAI/ardur-bot --pattern ardur.rb
git checkout -b ardur-0.1.0-alpha.2
cp ardur.rb Casks/ardur.rb
```

Push the branch and open a pull request. The tap CI checks the cask against the release's
`checksums.txt` for both Mac architectures, audits it, and fetches the Apple silicon DMG.
After the pull request merges, users run:

```sh
brew tap ArdurAI/tap
brew trust --cask ArdurAI/tap/ardur
brew install --cask ArdurAI/tap/ardur
```

Current Homebrew requires the trust step before it loads a third-party cask; Homebrew
releases without the trust command can skip it. Homebrew verifies the downloaded checksum
against the cask's SHA-256. For previews without an identified developer, use **Open Anyway**,
or install with `brew install --cask --no-quarantine ArdurAI/tap/ardur`.
Signed and notarized builds omit these caveats and open normally.

## Window placement

The main window remembers its normal size, position, display, maximized and full-screen state across restarts. It uses the saved display when still connected and keeps usable bounds fully inside its work area, shrinking only when needed. If the saved top area is unreachable, it centres the default size on the saved display, the display containing the saved centre, or the primary display, in that order. Linux Wayland may let the compositor choose its position.

Full-screen restore starts after the window is shown. Placement saves wait for full-screen entry to finish. Closing saves immediately; quitting waits up to two seconds for a pending write, then exits even if storage stalls.

## Platform acceptance still required

Windows and Linux use native window frames plus a tray with Open and Quit actions. Closing the
main window keeps it reachable through the tray; its retained renderer is destroyed after the
existing warm-window timeout. Reopening restores the window, and a second launch activates the
running instance. macOS uses native traffic lights and the dock. A missing tray host falls back to
normal last-window exit. Some Linux desktop environments need an AppIndicator extension; tray
visibility must be checked on the actual desktop.

Unit tests stub the platform and Electron tray boundary. Release install acceptance above checks
installed startup, not interactive tray integration, DPI behavior, or window-manager usability.
The local macOS arm64 directory build passed deep, strict codesign verification; all 128
Mach-O files had valid ad-hoc signatures. Gatekeeper assessment returned `rejected`, not a damaged
resource-seal error, as expected without Developer ID. This is not a quarantined DMG first-open
test or signed notarization acceptance. Installed-app tray/dock behavior, idle CPU, update
discovery, Intel packaging, and credentialed notarization still require platform acceptance.
Do not interpret unit tests or generated YAML as that acceptance evidence.
