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

The Account, Capabilities, Memory, System, Extensions, Developer, Skills, Integrations, MCP and Plugins slots are already reserved. Replace the corresponding line when its page lands; do not append a duplicate id. Account uses its page through this one-line registration:

```ts
{ id: "account", group: "Settings", label: msg`Account`, icon: User, component: lazy(() => import("./account/AccountSettings")), available: always },
```

Capabilities and Memory now use their pages under `pages/capabilities/` and `pages/memory/` in those existing slots. Memory → Memory storage → Manage opens the existing embedded storage settings, including Git repository memory and semantic providers; Back to memory returns to the proposal and document view. Skills opens the existing Skills section under Customize. The Capabilities Computers link opens the owner section for deployment owners and a read-only computer list for other members. Both pages register their setting rows with search and release busy state when unmounted.

Use `desktopOnly` for System, Storage, Extensions and Developer. Storage lists disk usage by directory (Database, Computer homes, Checkpoints, Artifacts, Boards, an optional Sessions row, App cache, and an optional Previous Docker data row for an install that has not moved off its legacy Compose stack) and offers one action, Clear caches, which never touches the database, `data/`, `stack/` or `host-service/`. Sizes come from a symlink-safe main-process walk capped at 20,000 entries; a capped row is shown as "at least". Keep the `computer` id for Computers and `integrations` for Integrations. There is no `connectors` alias. Integrations and MCP are always available under Customize. Native routes and RPC namespaces retain their existing names.

The sidebar and composer both open Settings → Integrations, backed by the trusted integration registry. Its Yours and Catalog tabs share a searchable table with connection type, provenance, and reconnection state. Custom MCP servers live in MCP, not in the product catalog. `initialIntegration` carries composer reconnection into `IntegrationCatalog.reconnectId`; `connectors.summary` supplies the composer reconnection count. MCP embeds the existing servers overlay, adds opt-in Context7 and DeepWiki defaults, and opens tool review after enablement. Local server status, redacted logs, and reviewed configuration changes also live in MCP. On desktop, choosing STDIO uses the native configuration editor and its packaged host-service routing. Developer shows only the connected server URL and desktop version. The legacy plugin catalog dialog is no longer on the sidebar path. Its obsolete GraphQL browser entry test is retired; backend GraphQL tests remain.

The bundle baseline retains its original initial-JavaScript budget. Its retired `PluginsOverlay` entry is replaced by guards for the lazy Settings pages and the trusted registry. The former Developer, Skills, and Plugins placeholder guards now point to their `customize/` pages, with an additional Extensions guard. All four remain dynamic and outside the initial dependency graph; the numeric size baseline is unchanged.

The consolidation build measured 411,478 bytes of initial JavaScript at gzip level 9. An isolated build of the merged `dev` parent, `65769ee0`, with the same dependencies measured 410,482 bytes: a 996-byte increase. Both exceed the historical 397,771-byte baseline plus its 10,240-byte growth allowance. The advisory remains visible rather than replacing the numerical baseline.

Pages receive `SettingsPageProps` from `settings-types.ts`: account display values, existing configuration callbacks, `navigate(section)`, `onClose()` and `onBusyChange(busy)`. An embedded page must not open another Settings dialog. Release busy state on unmount. Extensions, Developer, Skills, and Plugins replace their reserved registrations with lazy pages under `customize/`. Extensions and Developer retain desktop-only availability. Native Skills, MCP, and Plugins remain read-only; native Integrations retains the trusted catalog and opens the web connect flow.

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
7. Open Extensions, Developer, Skills, and Plugins through their registry entries. Verify that Developer contains no MCP controls, managed servers cannot be changed in MCP, default servers need explicit enablement and tool approval, and local config changes show a diff before applying.

Offline unit tests cover the contracts, persistence, filtering, appearance attributes and CSS, notification gates and transports, export, upload ownership, desktop IPC and mobile preferences. The web `settings-shell.spec.ts` captures General, row search and Privacy. Native OS notification delivery and host lifecycle still need a signed desktop build and a phone; the desktop Playwright suite is deliberately excluded from routine local verification.

The composer prerequisite is the existing `355c8852` commit from `dev`. Account owns profile, avatar, password, shared bot instructions, trusted devices and sessions. General owns language and appearance. Privacy owns account and memory export. Account deletion remains in the native mobile Account screen; it is omitted from web and desktop Account. The preference migration uses `20260924052000_user_preferences`; its SQL is identical to the initial Settings migration. This keeps the comparisons timestamp `20260924050000` and account-settings timestamp `20260924055000` free for their streams.

## Integration management

`IntegrationsSection.tsx` lazily renders the compatibility `IntegrationCatalog`
export of `IntegrationCards` from `components/integrations/card/`. That controller uses `IntegrationTable` as its
only list, with Yours/Catalog and search. One row represents one catalog provider;
local CLI sign-ins and remote accounts appear as options within that row. The Type
column shows Desktop, Web, or both. Included provenance and the most urgent
connection state stay visible. `IntegrationCatalog` is a compatibility export of
that same controller, not a second connection flow.

Manage replaces the list with `IntegrationDetails` under
`components/integrations/manage/`. Test and Reconnect use the selected connection;
returning to the list preserves search and tab selection. Pending sign-ins retain
Cancel and completion polling. Composer reconnection opens this same detail flow;
`connectors.summary` counts remote and host connections in `needs-sign-in`. MCP remains the home for custom and managed servers,
opt-in defaults, diagnostics, redacted logs and reviewed configuration changes.

Manage shows account/workspace when the provider supplies them, scopes, captured
tools, Allow/Ask/Block controls, bot grants, last use and health, and recent safe
errors. Block removes the tool from the grant. Allow applies only to read tools;
write tools and host command execution always require Ask-first. A changed tool
schema or identity clears previous grants for review. Test preserves grants when
the identity and tool definitions are unchanged. `McpToolReview` uses the same Allow/Ask/Block control and saves through
`mcp.servers.permissions`. The API shares `IntegrationConnections.assign` while
checking whether the connection belongs to the catalog or MCP. Bot grants remain
scoped to the chosen server; existing grants for other servers stay intact. Only
the space owner can change read approvals. Tool changes and permission saves
invalidate pending approvals and stale tool routes. Managed configuration still
belongs to Extensions or Plugins.

Mobile reads the same states and links to web management; it does not modify
connection permissions.

The Models Anthropic panel links a current bot to **Runs on → Claude Code**.
The built-in runtime still accepts an API key only. See
[integration lifecycle](./decisions/integration-lifecycle.md) for callback,
refresh, provider limitations and manual verification.

## Auto Review configuration

`ActionAutoReviewSettingsSchema.configurationWarning` reports `jev-key-missing`
when Jev is selected without a TypeSafe key. `ApprovalRulesSettings`, shared by web
and desktop, shows “Jev needs a TypeSafe API key.” even when the LLM fallback is
available or the toggle is off. This appears only for that deployment
misconfiguration. The API logs the same sentence once per process. The existing
fallback checker and Ask-first behavior remain unchanged. Mobile has no Auto Review
status control.

The bundle guard for the former `ToolPicker` shared chunk now follows
`ToolPermissions`, which serves catalog and MCP review. It stays outside the
initial graph. The historical numeric bundle baseline is unchanged; the follow-up
budget compares actual builds against the merged `dev` revision.

## Integration reconciliation verification

The merge of `dev` revision `cd4f634d` is `4582f9c3`. Follow-up changes remain
uncommitted. Actual production builds measured 412,550 bytes of initial JavaScript
gzip on `dev` and 413,341 bytes after reconciliation: 791 bytes of growth against a
1,024-byte limit. Both builds used the same locked dependencies and
`scripts/bundle-budget.mjs` at gzip level 9. The direct comparison reports the
expected removal of `chunk:ToolPicker`; its replacement `chunk:ToolPermissions`
remains lazy. No numerical baseline was raised.

`pnpm exec vitest run --maxWorkers=3` passed 6,276 tests, with 168 skipped and no
failures, across 666 passing and 30 skipped files. The existing Postgres,
Docker/Compose, end-to-end and live-canary gates account for the skipped files.
Workspace checks passed with `EXPO_OFFLINE=1`; Biome and lint passed with repository
warnings and no errors. Prisma generation, web build, desktop build, host-service
build, web extraction and mobile catalog deduplication passed.

The lifecycle migration retains `20260924150000_integration_lifecycle` unchanged.
No migration was applied to an existing deployment. Live provider consent, packaged
OS protocol acceptance, physical mobile checks and browser end-to-end screenshots
remain manual. Windows native filesystem binaries were absent from the real local
build; the existing refusal of unsupported Windows writes remains in place.
