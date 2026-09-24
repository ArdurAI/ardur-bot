# Settings shell

## Registration contract

`apps/web/src/pages/settings-sections.ts` is the only section registry. Each line describes one lazy section. The shell does not import pages eagerly or switch on page implementations.

```ts
type SettingsRegistration = {
  id: SettingsSection;
  group: "Settings" | "Desktop app" | "Customize" | "Platform";
  label: MessageDescriptor;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  component: LazyExoticComponent<ComponentType<SettingsPageProps>>;
  available: (context: SettingsContext) => boolean;
};
type SettingsContext = { desktop: boolean; isDeploymentOwner: boolean };
```

The Account, Capabilities, Memory, System, Extensions, Developer, Skills, Integrations, MCP and Plugins slots are already reserved. Replace the corresponding line when its page lands; do not append a duplicate id. For the existing Account export, the exact one-line registration is:

```ts
{ id: "account", group: "Settings", label: msg`Account`, icon: User, component: lazy(() => import("./AccountSettingsOverlay").then((m) => ({ default: m.GeneralSettingsPanels }))), available: always },
```

Use `desktopOnly` for System, Extensions and Developer. Keep the `computer` id for Computers and `integrations` for Integrations. There is no `connectors` alias. Integrations and MCP are always available under Customize. Native routes and RPC namespaces retain their existing names.

The sidebar and composer both open Settings → Integrations, backed by the trusted integration registry. `initialIntegration` carries composer reconnection into `IntegrationCards.reconnectId`. MCP embeds the existing servers overlay, with Add MCP server revealing the form and Manage MCP servers showing existing connections. Developer shows the connected server URL and desktop version. The legacy plugin catalog dialog is no longer on the sidebar path. Its obsolete GraphQL browser entry test is retired; backend GraphQL tests remain.

The bundle baseline retains its original initial-JavaScript budget. Its retired `PluginsOverlay` entry is replaced by guards for the lazy Settings pages and the trusted registry.

Pages receive `SettingsPageProps` from `settings-types.ts`: account display values, existing configuration callbacks, `navigate(section)`, `onClose()` and `onBusyChange(busy)`. An embedded page must not open another Settings dialog. Release busy state on unmount. Existing panels remain reachable until replacements arrive; Plugins has a single empty state.

Use `SettingsRow` from `components/SettingsRow.tsx` for rows. Its `label` registers the open page's searchable label and accessible group name. A query matching the section title shows all its rows; other queries filter its registered rows. Registration cleans up on unmount. `description` is optional; `content` supports details revealed by a row action.

## Persistence and platform boundaries

`preferences.get/update` use the authenticated user, independent of the selected space. Updates write only supplied columns, including individual notification flags. The additive `20260924052000_user_preferences` migration introduces `user_preferences` plus indexes for account notification activity and uploaded files. Existing accounts need no backfill; reads supply defaults until the first update. The previous avatar update contract remains supported.

`PreferencesProvider` shares one initial read per account, with an account-scoped startup cache. The shell waits for that read to settle; a layout effect applies server preferences before rendering its content. The inline startup script applies cached appearance attributes. Font stacks live in `@ardurbot/ui-tokens`. Mobile appearance and motion follow the OS rather than desktop account overrides.

The desktop keep-working preference is machine-local in the existing host-service storage directory. It does not travel with account preferences. Closing the main window with it disabled stops the owned host service and quits; enabling it retains the tray or dock lifecycle and the authenticated renderer for notifications. This retains renderer memory while the app works in the background.

## Notifications

`packages/core/src/notifications.ts` owns the preference gate and category classification. Routines include completion, failure and requests for input. Other approvals use `approvalsNeeded`; Dispatch results use `dispatchMessages`; ordinary run endings use `responseCompletions`. Existing per-bot muting and delegated-run suppression still apply.

The executor uses this gate before the existing push adapter. Web and Electron observe account activity every five seconds, including other threads and spaces. Initial history and muted events are consumed without replay. Foreground notifications are suppressed. Electron delivers through validated main-process IPC; browsers require notification permission requested by a user action. Dispatch messages use the existing phone push route.

Controls are conditional on delivery support. Native account controls use the same RPC and native switches. A phone with only a Dispatch grant cannot change account preferences or register account push tokens, so these controls are hidden there. Signed-in mobile builds need the existing push configuration or Android live notification service. No new hosted service is required.

## Privacy and verified omissions

Account export reuses bot export and includes profile, preferences, current space memberships, owned bots, memory, conversations, uploaded bytes, usage, feedback and learning consent. Explicit selections exclude authentication state, provider credentials and internal storage keys. Memory export remains available separately. Upload list and delete are restricted to owned uploads in current memberships; generated artifacts are excluded. Storage removal must succeed before metadata is removed, so a failed deletion can be retried.

Registered folders grant filesystem access; consequential actions still require approval. General therefore uses the narrower permission sentence. The current Voice page exposes provider and voice selection; General links to that working page. This base has no host browser-control path or local API-token management surface, so Preferred browser and Local API are omitted. Shared-chat, shared-artifact, feedback-management and vendor-policy surfaces are not invented.

## Review across surfaces

1. Open Settings from the sidebar, account menu and keyboard shortcut. Check group ordering, search and repeated close/reopen.
2. In General, change theme, font and motion; reload and inspect the transcript. Mobile should continue following device appearance and reduced motion.
3. Follow Trusted folders to Computers and verify the count against the registered folders. In a desktop build, verify both keep-working states with a local host task.
4. Allow notifications, change each available category, then finish a run, finish or fail a routine, request an approval and receive a Dispatch result. Test enabled and disabled states while another conversation is open.
5. In Privacy, export account JSON and memory, inspect uploads, cancel a deletion, confirm it, and verify another account cannot list or delete those files.
6. Open Integrations from the sidebar and composer. Check the ten registry entries, reconnect a connection from the composer, then open MCP and add or manage a server. Verify the old catalog dialog never opens.
7. Open every fallback section before replacing registrations. Keep MCP's existing lazy boundary intact when adapting it for the shell.

Offline unit tests cover the contracts, persistence, filtering, appearance attributes and CSS, notification gates and transports, export, upload ownership, desktop IPC and mobile preferences. The web `settings-shell.spec.ts` captures General, row search and Privacy. Native OS notification delivery and host lifecycle still need a signed desktop build and a phone; the desktop Playwright suite is deliberately excluded from routine local verification.

The composer prerequisite is the existing `355c8852` commit from `dev`. No comparison or account-stream implementation is included. The preference migration uses `20260924052000_user_preferences`; its SQL is identical to the initial Settings migration. This keeps the comparisons timestamp `20260924050000` and account-settings timestamp `20260924055000` free for their streams.

## Integration management

`IntegrationsSection.tsx` renders `IntegrationCards` from
`components/integrations/card/`. Connection details and tool permissions live in
`components/integrations/manage/`. Keep the section wrapper small so the adjacent
Connectors table can share the Integrations section without moving this UI.

Manage shows account/workspace when the provider supplies them, scopes, captured
tools, Allow/Ask/Block controls, bot grants, last use and health, and recent safe
errors. Block removes the tool from the grant. Allow applies only to read tools;
write tools and host command execution always require Ask-first. A changed tool
schema or identity clears previous grants for review. Test preserves grants when
the identity and tool definitions are unchanged. Mobile reads the same states and
links to web management; it does not modify connection permissions.

The Models Anthropic panel links a current bot to **Runs on → Claude Code**.
The built-in runtime still accepts an API key only. See
[integration lifecycle](./decisions/integration-lifecycle.md) for callback,
refresh, provider limitations and manual verification.
