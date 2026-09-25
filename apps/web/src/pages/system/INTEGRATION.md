# Desktop System settings

The System page is connected through `apps/desktop/src/main.ts`, the existing sandboxed
`preload.cjs`, and the settings overlay. New desktop behavior lives in
`apps/desktop/src/system/`; the page, quick composer, and dictation integration live in
`apps/web/src/pages/system/`. There are no new runtime dependencies.

## Behavior and decisions

- `SystemStore` uses the existing desktop store's private, bounded reads and atomic writes
  for `system-settings.json` under `app.getPath("userData")`. Operating-system startup state
  is read back rather than inferred from the saved preference. `app.getVersion()` supplies
  the same value as the existing `--version` path.
- The main process owns shortcuts, the power blocker, and a 30-second routine poll. Turning
  on the power setting and connecting the main window also refresh routine status. The
  private local-stack token authenticates `/local/system/routines`; renderer closure does
  not end polling. A failed status request releases the blocker. Existing-instance mode
  hides this control because that server's scheduler does not run in the managed local stack.
- Quick access uses the existing authenticated renderer session and the normal
  `rpc.threads.send` API. The user explicitly chooses a coordinator bot; there is no global
  coordinator preference in the existing schema. Its choice is saved privately in
  `quick-access.json`, bound to the server origin, account and space. Failed sends retain
  their idempotency nonce. Escape closes the small, always-on-top native window.
- Global voice and in-window dictation use the existing `dictation` engine and append to the
  active draft. Shortcut readiness is bound to the assigned window origin even before startup
  commits the active server; only main-frame document navigation resets that readiness.
  A second press finishes transcription. In-window dictation requires focus
  in the chat input. Existing voice calls are not interrupted. Unmounting or hiding the
  composer cancels its recording.
- The optional macOS menu bar item reuses `tray.ts`, including current host-service state,
  Open and Quit. Its image is an Electron template image. Windows and Linux keep the
  existing tray behavior. A menu bar creation failure leaves the main app usable.
- Chat links follow the local viewer preference after the existing OAuth-popup rule runs.
  External sites get an ephemeral session, no application preload, and no native permission
  grants. The quick composer cannot invoke the main window's System settings IPC.
- Dispatch uses a separate `RemoteAuthorityPolicy` row with layer `desktop-dispatch` and
  the current space as `subjectId`. An absent row preserves existing Dispatch behavior;
  paired grants remain mandatory. Only the deployment owner may change it. Enabling it
  cannot widen independent space, bot, user or device policies. Phone request handling,
  shared database admission, messaging consumption, and approval validation all enforce it.
  Read and stop remain available while it is off. This does not cancel already accepted work.
- The phone listener now uses `LOCAL_SETTINGS_TOKEN_HEADER`, matching the API validator.

## Storage decision

Storage move buttons are hidden in both modes. Existing-instance storage is managed by its
server. This-computer storage includes the Compose `appdata` and `pgdata` named volumes;
`app.getPath("userData")` is not the artifacts or routines database directory. The page
therefore reports managed Docker storage instead of inventing a host folder path.

`LocalStackController.stop()` stops the Compose services, while the supervisor creates
independent computer containers. The current stack API has no verified operation to quiesce
all of those writers, migrate both volumes with ownership intact, and recover their mounts
on restart. Copying only the Compose directory would leave the actual data behind; copying
live volumes would risk inconsistent data. No move backend is installed and no native picker
is exposed. This is the brief's permitted safety fallback, not a completed Docker migration.

The isolated `StorageMove` transaction and local-file copier are tested for confirmation,
path validation, restart failure, rollback, and retaining original data. They are not enabled
until a concrete backend can satisfy the volume and computer-container requirements above.

## Rows deliberately omitted

- Linux startup: no XDG autostart writer is included; Electron's login-item API supports
  macOS and Windows only.
- “Tap Option twice” and “Caps Lock”: neither is offered as a global accelerator without
  adding native key hooks.
- “Chrome on this Mac”: the host adapter has no browser-control backend. Connected browsers
  list the running, graphical container computers with available screens instead.
- “Allowed sites”: current approval rules match tools, connectors and categories, not
  domains; browser navigation has no domain permission gate.
- Per-computer “Enable computer use”: screen availability and boot/stop exist, but there is
  no persisted per-computer tool-authorization switch. Stopping a computer is not denial of
  future computer tools.
- “Background” and “Full control”: screen leases transfer control between a bot and a person;
  they do not implement two operating-system automation modes.
- “Unhide apps when finished” and “Denied apps”: the host adapter has no app-level policy.
- Accessibility, Screen recording and Menu bar are hidden outside macOS.
- “Keep computer awake” is hidden in existing-instance mode as explained above.

## Settings-shell merge

This checkout has no `settings-sections.ts`. `SettingsOverlay.tsx` has one System registration
entry and small generic support for an optional group and page component. When merging
`feat/settings-shell`, remove that fallback wiring and replace the shell's existing System
entry with this registration; do not add a second entry or use the old computer panel:

```tsx
{ id: "system", group: "Desktop app", label: msg`System`, icon: Monitor, component: lazy(() => import("./system/SystemPage")), available: desktopOnly },
```

`SystemPage` has a default export and remains hidden when the System bridge is absent.
The web catalogs contain the extracted source copy; merge catalog conflicts by extracting
again after both branches are combined. Shared RPC additions also require the matching API
build; an older server reports Dispatch as unavailable instead of showing an unenforced toggle.

## Persona impact

- Operator: one System page exposes startup, quick messaging, voice input and readable
  permission status without editing configuration.
- Builder: deterministic shortcuts, native cleanup, actual browser availability and the
  existing-instance boundary are inspectable and covered by offline tests.
- Researcher: enabled routines can keep the managed local scheduler awake after the main
  window closes, and shortcut messages remain in the normal durable conversation.
- Team lead: the selected space's Dispatch control blocks new phone and paired-chat work,
  steering and approval while preserving independent restrictions and stop access.
- Local-first user: machine preferences remain local, external sites cannot reach desktop
  IPC, and storage capability is described honestly.

## Primary API references

- [Electron login items](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings):
  platform support, `openAtLogin`, native read-back and Windows enablement.
- [Electron global shortcuts](https://www.electronjs.org/docs/latest/api/global-shortcut):
  readiness, registration failures and unregistering acquired accelerators.
- [Electron powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker):
  `prevent-app-suspension` permits display sleep and returns the ID to stop.
- [Electron systemPreferences](https://www.electronjs.org/docs/latest/api/system-preferences):
  `isTrustedAccessibilityClient(false)` and `getMediaAccessStatus("screen")`.
- [Electron Tray](https://www.electronjs.org/docs/latest/api/tray): macOS template images and
  context menus.
- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window) and
  [BaseWindow](https://www.electronjs.org/docs/latest/api/base-window): secure window options,
  `alwaysOnTop`, and the limitation that Wayland does not support always-on-top windows.

- [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents): main-frame
  and same-document navigation events used to renew shortcut readiness.
