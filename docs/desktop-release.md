# Desktop pre-releases

Desktop previews are unsigned. No Developer ID, notarization credentials, or Windows certificate
is configured. Work lands on `dev`; `main` moves only after a human verifies a build. CI quality
and performance checks are advisory. Packaging must still finish before an artifact can be published.

## Build contract

A `v*` tag push runs `.github/workflows/release-desktop.yml`. Manual dispatch accepts an existing
`tag` input. Both routes validate that the tag matches the **root** `package.json` version and points
to a commit on `dev`. They never move `main` or overwrite an existing release.

| Platform | Architecture | Release assets |
| --- | --- | --- |
| macOS | arm64, x64 | DMG and ZIP for each architecture |
| Linux | x64, arm64 on the native ARM runner when supported | AppImage and deb |
| Windows | x64 | NSIS installer |

Builds run separately, so macOS update metadata is merged before publication; neither architecture
can overwrite the other's ZIP entry. Each feed's version and referenced assets are checked. Only
installers, blockmaps, channel feeds, and the generated cask are attached to a GitHub **pre-release**.
It is never marked latest. The application feed remains `ArdurAI/ardur-bot`.

The root version is the sole editable input. `scripts/desktop-version.mjs` copies it into the
desktop package before every desktop build; that package field is derived packaging metadata.
The executable's `--version` flag prints `app.getVersion()` and exits before taking the instance
lock, opening a window, checking updates, or starting Docker. With the Homebrew cask or Linux deb,
run `ardur-bot --version`; from a DMG install run the bundle executable with `--version`.

Release notes count commits since the previous reachable `v*` tag (all ancestors for the first
release), grouped by `feat`, `fix`, `perf`, `docs`, `build`, `ci`, `test`, `refactor`, `chore`, `style`,
and `revert`. Fixed labels and counts prevent commit subjects, scopes, author names, and file paths
from leaking into generated notes. This deliberately trades detailed changelog prose for safe,
repeatable publication.

## Unsigned configuration and updates

This repository pins electron-builder **26.15.3** and electron-updater **6.8.9**. The workflow sets
`CSC_IDENTITY_AUTO_DISCOVERY=false`, and the builder configuration sets `mac.identity=null`,
`mac.notarize=false`, and `win.signExecutable=false`. No certificates or notarization credentials
are passed. Windows retains executable icons and version metadata while skipping signing.

The documented environment switch disables signing discovery. In this pinned release, the
explicit notarization switch is the **configuration option** `mac.notarize=false`; there is no
verified separate notarization-skip environment flag to add. See the official
[macOS signing options](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/),
[macOS notarization option](https://www.electron.build/v26/docs/mac/), and
[Windows signing option](https://www.electron.build/v26/docs/api/app-builder-lib.interface.windowsconfiguration/).

Unsigned macOS apps cannot apply electron-updater updates automatically; its
[auto-update documentation](https://www.electron.build/v26/docs/features/auto-update/) requires
code signing. These unsigned previews use download-only updates on all desktop platforms, so the
UI never claims a verified in-place installation. On discovery it shows **“A new version is
available — download”**, linking to the official release page. This copy appears only when a new
version exists; removing it would leave users without an update action. “Open Ardur Bot” and “Quit”
are the tray actions, necessary to reopen or leave the background app.

`autoDownload` and `autoInstallOnAppQuit` remain off for preview installs, pre-release discovery is
on, and downgrade checks remain disabled. Windows signature verification is retained for a future
signed channel; it is not bypassed to make an unsigned automatic update appear verified. Signed
builds come later and require an explicit change to this policy.

## Cut a preview

1. Land and review the changes on `dev`. Set the root version to `0.1.0-alpha.1`, run
   `node scripts/desktop-version.mjs`, and include the derived desktop metadata in that change.
2. Build and verify the app locally where possible. Push the approved `dev` revision, then:

   ```sh
   git tag v0.1.0-alpha.1
   git push origin v0.1.0-alpha.1
   ```

3. Alternatively, dispatch the workflow on `dev` with the existing tag:

   ```sh
   gh workflow run release-desktop.yml --ref dev -f tag=v0.1.0-alpha.1
   ```

4. Wait for the pre-release assets. Download the DMG matching the Mac architecture, drag
   **Ardur Bot.app** to **Applications**, eject the DMG, and follow the unsigned-opening steps
   in the [README](../README.md#install-a-desktop-preview). Open it, confirm the version in update
   settings, and complete setup. “This computer” still requires Docker Desktop and published
   backend images for the selected release; packaging a client does not prove those images exist.
5. Verify a real installed build before deciding whether `main` should move. Do not retag a
   published version; create a new version for fixes.

For an unsigned host directory build:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @ardurbot/desktop pack:dir
```

`--dir` validates and packages an unpacked app; it does not exercise DMG mounting, quarantine,
NSIS installation, or deb dependencies. The desktop Playwright suite belongs in CI, where it
runs in a virtual display.

## Homebrew tap handoff

`homebrew/Casks/ardur-bot.rb` is a template, not an installable cask yet. The release workflow
fills its version, architecture-specific DMG URLs, and SHA-256 values from the built files and
attaches `ardur-bot.rb` to the pre-release. It never contacts a tap or makes a repository commit.

After the owner creates `ArdurAI/homebrew-tap`, these **two commands** publish the first cask:

```sh
gh release download v0.1.0-alpha.1 --repo ArdurAI/ardur-bot --pattern ardur-bot.rb --dir homebrew/Casks --clobber
gh api repos/ArdurAI/homebrew-tap/contents/Casks/ardur-bot.rb --method PUT -f message='build: publish desktop cask' -f content="$(base64 < homebrew/Casks/ardur-bot.rb | tr -d '\n')"
```

For later updates, the second command also needs the current cask file's `sha` parameter.
Users can then run:

```sh
brew install --cask ardurai/tap/ardur-bot
```

Homebrew verifies the downloaded checksum. It does not sign, notarize, or silently remove
quarantine from the app. Use the same opening instructions as a direct download.

## Platform acceptance still required

Windows and Linux use native window frames plus a tray with Open and Quit actions. Closing the
main window keeps it reachable through the tray; its retained renderer is destroyed after the
existing warm-window timeout. Reopening restores the window, and a second launch activates the
running instance. macOS uses native traffic lights and the dock. A missing tray host falls back to
normal last-window exit. Some Linux desktop environments need an AppIndicator extension; tray
visibility must be checked on the actual desktop.

Unit tests stub the platform and Electron tray boundary. No real Windows or Linux installer,
tray integration, DPI behavior, or window manager was exercised during this implementation.
On macOS the sandbox blocked downloading Electron for the directory build; the installed app,
Gatekeeper steps, tray/dock behavior, Docker-backed idle CPU, and update discovery still need a
real build. Do not interpret unit tests or generated YAML as that acceptance evidence.
