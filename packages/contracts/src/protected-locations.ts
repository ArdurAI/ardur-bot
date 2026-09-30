import { z } from "zod";

/**
 * Protected locations on a host computer ("This Mac").
 *
 * The host guardrail keeps bots away from Ardur's own keys and database, and nothing
 * else. A bot whose computer is the owner's own Mac can still read the owner's cloud
 * credentials (`~/.aws`, `~/.kube`, `~/.ssh`) and can write into the agent tools' own
 * folders (Codex's, Claude Code's), where a planted file changes what those tools
 * load. The owner keeps cloud credentials on this Mac and decided: protect by
 * default, grant per bot.
 *
 * This file is the whole framework as one typed table: adding a protected location
 * is one entry in PROTECTED_LOCATIONS_DEFAULTS, and which kind of process is kept
 * out of what is one table, PROCESS_LOCATION_RULES. Paths are written from the home
 * folder (`~/.aws`) and name a folder or a file. No node imports: the browser loads
 * this file.
 */

/** The most locations an owner can add. */
const CUSTOM_LOCATIONS_MAX = 64;

/** Which flavor of protected location an entry is. */
export const ProtectedLocationKindSchema = z.enum(["credentials", "agent-tool"]);
export type ProtectedLocationKind = z.infer<typeof ProtectedLocationKindSchema>;

/**
 * The agent tool an entry belongs to. Kept as a plain string (not the RuntimeKind
 * enum) so a location can name a tool Ardur does not run as a runtime and so the
 * table does not change shape when the runtime list changes.
 */
export const ProtectedLocationToolSchema = z.string().min(1).max(64);
export type ProtectedLocationTool = z.infer<typeof ProtectedLocationToolSchema>;

/** A character that is not text: below a space, or delete. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * `~/name` or `~/name/inner`: written from the home folder, every part a real name. An empty
 * part (`~//`), a trailing separator, `.` and `..` are refused here, so nothing that is
 * stored can name the home folder itself or a place outside it. A path is plain text: a
 * line break or another control character is refused.
 */
const locationPath = z
  .string()
  .min(3)
  .max(512)
  .refine(
    (value) =>
      value.startsWith("~/") &&
      !hasControlCharacter(value) &&
      value
        .slice(2)
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\\")),
    "A location path names a folder or file inside the home folder, written from it.",
  );

/**
 * True when one path is the other or sits inside it. Letter case and the two ways of
 * writing an accented letter are ignored: on a Mac `~/.AWS` and `~/.aws` are one folder.
 */
function overlaps(left: string, right: string): boolean {
  const a = left.normalize("NFC").toLowerCase();
  const b = right.normalize("NFC").toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * One protected location. `paths` names folders or files written from the home
 * folder; `tool` is present exactly when `kind` is "agent-tool" (the schema enforces
 * this).
 */
const protectedLocationId = z.string().min(1).max(64);
const GRANTS_PATCH_MAX = 128;

export class ProtectedLocationsPatchError extends Error {}

export const ProtectedLocationSchema = z
  .object({
    id: protectedLocationId,
    label: z.string().min(1).max(120),
    paths: z.array(locationPath).min(1).max(16),
    kind: ProtectedLocationKindSchema,
    tool: ProtectedLocationToolSchema.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.kind === "agent-tool" && entry.tool === undefined)
      ctx.addIssue({ code: "custom", message: "An agent-tool location names its tool." });
    if (entry.kind === "credentials" && entry.tool !== undefined)
      ctx.addIssue({ code: "custom", message: "A credentials location names no tool." });
  });
export type ProtectedLocation = z.infer<typeof ProtectedLocationSchema>;

/**
 * The protected locations every host starts from. Sources for the agent-tool
 * folders (never guess a path — each entry cites where its folder comes from):
 * - Codex, `~/.codex`: this repository's adapter code, which reads the owner's
 *   global `AGENTS.md`, skills and `config.toml` from `~/.codex`
 *   (packages/host-runtime/src/import/scanner.ts, localImportDefaults and the
 *   codex scan branch; docs/local-import.md's Codex row cites the vendor's
 *   configuration reference).
 * - Claude Code, `~/.claude` and `~/.claude.json`: the same adapter code reads the
 *   owner's global `CLAUDE.md`, project memories, skills, `settings.json`, the
 *   installed plugin registry and the root configuration `~/.claude.json`
 *   (packages/host-runtime/src/import/scanner.ts; docs/local-import.md's Claude
 *   Code row cites the vendor's memory, skills, MCP and plugin documentation).
 * - Hermes, `~/.hermes`: the same adapter code reads the owner's `SOUL.md`,
 *   skills and `config.yaml` from `~/.hermes` (packages/host-runtime/src/import/
 *   scanner.ts; docs/runtimes/hermes.md and docs/local-import.md's Hermes row).
 * - Gemini CLI and Antigravity, `~/.gemini`: the Gemini CLI keeps its sign-in
 *   there (`oauth_creds.json`, with `settings.json` beside it; Gemini CLI
 *   documentation, "Authentication setup"), and Antigravity's `agy` CLI keeps its
 *   settings, plugins and skills in `~/.gemini/antigravity-cli/` (Antigravity CLI
 *   documentation, "Settings" and "Plugins"). One entry covers the folder and
 *   names Antigravity as its tool, so an Antigravity turn keeps its own settings
 *   and a bot's command stays out of both.
 *
 * The credentials entries are the standard, documented configuration locations of
 * each tool on a macOS/Linux home folder. What a list of paths cannot cover: the
 * login keychain, which commands reach through a system service and not through a
 * file, and a credential store moved elsewhere with an environment variable
 * (`KUBECONFIG`, `AWS_SHARED_CREDENTIALS_FILE` and the like).
 */
export const PROTECTED_LOCATIONS_DEFAULTS: ProtectedLocation[] = [
  { id: "aws", label: "Amazon Web Services credentials", paths: ["~/.aws"], kind: "credentials" },
  { id: "azure", label: "Azure credentials", paths: ["~/.azure"], kind: "credentials" },
  {
    id: "google-cloud",
    label: "Google Cloud credentials",
    paths: ["~/.config/gcloud"],
    kind: "credentials",
  },
  {
    id: "kubernetes",
    label: "Kubernetes credentials",
    paths: ["~/.kube"],
    kind: "credentials",
  },
  { id: "ssh", label: "SSH keys", paths: ["~/.ssh"], kind: "credentials" },
  { id: "gnupg", label: "GnuPG keys", paths: ["~/.gnupg"], kind: "credentials" },
  {
    id: "github-cli",
    label: "GitHub CLI sign-in",
    paths: ["~/.config/gh"],
    kind: "credentials",
  },
  { id: "docker", label: "Docker credentials", paths: ["~/.docker"], kind: "credentials" },
  {
    id: "netrc",
    label: "Netrc credentials",
    paths: ["~/.netrc"],
    kind: "credentials",
  },
  { id: "npmrc", label: "npm credentials", paths: ["~/.npmrc"], kind: "credentials" },
  {
    id: "git-credentials",
    label: "Git stored credentials",
    paths: ["~/.git-credentials"],
    kind: "credentials",
  },
  {
    id: "terraform",
    label: "Terraform credentials",
    paths: ["~/.terraform.d"],
    kind: "credentials",
  },
  { id: "pypi", label: "PyPI credentials", paths: ["~/.pypirc"], kind: "credentials" },
  {
    id: "cargo",
    label: "Cargo credentials",
    paths: ["~/.cargo/credentials.toml", "~/.cargo/credentials"],
    kind: "credentials",
  },
  { id: "maven", label: "Maven settings", paths: ["~/.m2/settings.xml"], kind: "credentials" },
  {
    id: "gradle",
    label: "Gradle properties",
    paths: ["~/.gradle/gradle.properties"],
    kind: "credentials",
  },
  {
    id: "codex",
    label: "Codex configuration",
    paths: ["~/.codex"],
    kind: "agent-tool",
    tool: "codex-app-server",
  },
  {
    id: "claude-code",
    label: "Claude Code configuration",
    paths: ["~/.claude", "~/.claude.json"],
    kind: "agent-tool",
    tool: "claude-code",
  },
  {
    id: "hermes",
    label: "Hermes configuration",
    paths: ["~/.hermes"],
    kind: "agent-tool",
    tool: "hermes",
  },
  {
    id: "gemini",
    label: "Gemini and Antigravity configuration",
    paths: ["~/.gemini"],
    kind: "agent-tool",
    tool: "antigravity",
  },
];

/**
 * Locations the owner adds beyond the defaults. The policy is stored per space and
 * read back with parseProtectedLocationsPolicy. The schema refuses a custom id that
 * repeats a default id and a custom id used twice, so `protectedLocations` can
 * never return two locations with one id.
 */
export const ProtectedLocationsPolicyV1Schema = z
  .strictObject({
    version: z.literal(1),
    custom: z.array(ProtectedLocationSchema).max(CUSTOM_LOCATIONS_MAX),
  })
  .superRefine((policy, ctx) => {
    const defaultIds = new Set(PROTECTED_LOCATIONS_DEFAULTS.map((location) => location.id));
    const seen = new Set<string>();
    // A path belongs to one location. Two locations over the same place would make a grant
    // for one of them do nothing, because the other still keeps the bot out.
    const taken = PROTECTED_LOCATIONS_DEFAULTS.flatMap((location) => location.paths);
    for (const location of policy.custom) {
      if (defaultIds.has(location.id))
        ctx.addIssue({
          code: "custom",
          message: `A custom location cannot repeat the default id "${location.id}".`,
        });
      if (seen.has(location.id))
        ctx.addIssue({
          code: "custom",
          message: `A custom location cannot repeat the id "${location.id}".`,
        });
      seen.add(location.id);
      for (const path of location.paths) {
        if (taken.some((other) => overlaps(path, other)))
          ctx.addIssue({
            code: "custom",
            message: `The path "${path}" is already part of a protected location.`,
          });
      }
      taken.push(...location.paths);
    }
  });
export type ProtectedLocationsPolicyV1 = z.infer<typeof ProtectedLocationsPolicyV1Schema>;

const PROTECTED_LOCATIONS_POLICY_EMPTY: ProtectedLocationsPolicyV1 = { version: 1, custom: [] };

function storedCustomEntries(raw: unknown): unknown[] | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const stored = raw as Record<string, unknown>;
  return stored.version === 1 && Array.isArray(stored.custom) ? stored.custom : undefined;
}

/**
 * The stored policy for a space. It never throws, and it reads each custom location on its
 * own: one that is malformed, repeats an id, or covers a place that is already protected is
 * left out, and the rest stay protected. A policy from another version reads as no custom
 * locations. `unreadProtectedLocations` says how many entries were left out.
 */
export function parseProtectedLocationsPolicy(raw: unknown): ProtectedLocationsPolicyV1 {
  const custom: ProtectedLocation[] = [];
  for (const entry of storedCustomEntries(raw) ?? []) {
    if (custom.length >= CUSTOM_LOCATIONS_MAX) break;
    const location = ProtectedLocationSchema.safeParse(entry);
    if (!location.success) continue;
    const next = { version: 1 as const, custom: [...custom, location.data] };
    if (ProtectedLocationsPolicyV1Schema.safeParse(next).success) custom.push(location.data);
  }
  return custom.length ? { version: 1, custom } : PROTECTED_LOCATIONS_POLICY_EMPTY;
}

/** How many stored custom locations could not be read, so a screen can say so. */
export function unreadProtectedLocations(raw: unknown): number {
  const stored = storedCustomEntries(raw);
  if (!stored) return 0;
  return stored.length - parseProtectedLocationsPolicy(raw).custom.length;
}

/**
 * Every protected location in force: the defaults followed by the policy's custom
 * ones. Ids stay unique because the schema refuses a custom id a default already
 * uses and parseProtectedLocationsPolicy never returns an invalid policy.
 */
export function protectedLocations(policy: ProtectedLocationsPolicyV1): ProtectedLocation[] {
  const custom = parseProtectedLocationsPolicy(policy).custom;
  return [...PROTECTED_LOCATIONS_DEFAULTS, ...custom];
}

/** Stored grants are all-or-nothing string lists; stale ids and duplicates are omitted. */
export function parseProtectedLocationGrants(
  raw: unknown,
  locations: readonly ProtectedLocation[],
): string[] {
  if (!Array.isArray(raw) || !raw.every((id) => typeof id === "string")) return [];
  const known = new Set(locations.map((location) => location.id));
  return [...new Set(raw.filter((id) => known.has(id)))];
}

export const ProtectedLocationGrantsPatchSchema = z.strictObject({
  grant: z.array(protectedLocationId).max(GRANTS_PATCH_MAX).optional(),
  revoke: z.array(protectedLocationId).max(GRANTS_PATCH_MAX).optional(),
});
export type ProtectedLocationGrantsPatch = z.infer<typeof ProtectedLocationGrantsPatchSchema>;

/** Apply an explicit grant/revoke delta, never replacing unrelated grants. */
export function applyProtectedLocationGrantsPatch(
  stored: unknown,
  patch: ProtectedLocationGrantsPatch,
  locations: readonly ProtectedLocation[],
): string[] {
  const { grant = [], revoke = [] } = ProtectedLocationGrantsPatchSchema.parse(patch);
  const known = new Set(locations.map((location) => location.id));
  const revoked = new Set(revoke);
  for (const id of [...grant, ...revoke]) {
    if (!known.has(id))
      throw new ProtectedLocationsPatchError(`Unknown protected location "${id}".`);
  }
  for (const id of grant) {
    if (revoked.has(id))
      throw new ProtectedLocationsPatchError(`Cannot grant and revoke protected location "${id}".`);
  }
  return [...new Set([...parseProtectedLocationGrants(stored, locations), ...grant])].filter(
    (id) => !revoked.has(id),
  );
}

export const ProtectedLocationsPolicyPatchSchema = z.strictObject({
  add: z.array(ProtectedLocationSchema).max(CUSTOM_LOCATIONS_MAX).optional(),
  remove: z.array(protectedLocationId).max(CUSTOM_LOCATIONS_MAX).optional(),
});
export type ProtectedLocationsPolicyPatch = z.infer<typeof ProtectedLocationsPolicyPatchSchema>;

export function applyProtectedLocationsPolicyPatch(
  stored: unknown,
  patch: ProtectedLocationsPolicyPatch,
): ProtectedLocationsPolicyV1 {
  const { add = [], remove = [] } = ProtectedLocationsPolicyPatchSchema.parse(patch);
  const removed = new Set(remove);
  for (const location of PROTECTED_LOCATIONS_DEFAULTS) {
    if (removed.has(location.id))
      throw new ProtectedLocationsPatchError(`Cannot remove default location "${location.id}".`);
  }
  return ProtectedLocationsPolicyV1Schema.parse({
    version: 1,
    custom: [
      ...parseProtectedLocationsPolicy(stored).custom.filter(
        (location) => !removed.has(location.id),
      ),
      ...add,
    ],
  });
}

export type ProtectedLocationView = ProtectedLocation & { custom: boolean; granted: boolean };

export const ProtectedLocationViewsSchema = z.array(
  ProtectedLocationSchema.safeExtend({ custom: z.boolean(), granted: z.boolean() }),
);
export const ProtectedLocationsReadInputSchema = z.strictObject({
  botId: z.string().min(1).optional(),
});
export const ProtectedLocationsPatchInputSchema = z.union([
  z.strictObject({ botId: z.string().min(1), patch: ProtectedLocationGrantsPatchSchema }),
  z.strictObject({ patch: ProtectedLocationsPolicyPatchSchema }),
]);
export type ProtectedLocationsPatchInput = z.infer<typeof ProtectedLocationsPatchInputSchema>;

/** Removal clears grants even when the same patch adds a replacement with that id. */
export function protectedLocationGrantsAfterPolicyPatch(
  stored: unknown,
  patch: ProtectedLocationsPolicyPatch,
  policy: ProtectedLocationsPolicyV1,
): string[] {
  const { remove = [] } = ProtectedLocationsPolicyPatchSchema.parse(patch);
  const removed = new Set(remove);
  return parseProtectedLocationGrants(
    stored,
    protectedLocations(policy).filter((location) => !removed.has(location.id)),
  );
}

/** The shared app list: defaults first, with bot grants applied only to known locations. */
export function protectedLocationViews(input: {
  policy: unknown;
  grants: unknown;
}): ProtectedLocationView[] {
  const policy = parseProtectedLocationsPolicy(input.policy);
  const locations = protectedLocations(policy);
  const granted = new Set(parseProtectedLocationGrants(input.grants, locations));
  const custom = new Set(policy.custom.map((location) => location.id));
  return locations.map((location) => ({
    ...location,
    custom: custom.has(location.id),
    granted: granted.has(location.id),
  }));
}

/**
 * The kinds of process the host runs, for PROCESS_LOCATION_RULES. A new kind is one
 * entry there.
 */
export const ProcessLocationKindSchema = z.enum([
  "bot-command",
  "agent-runtime",
  "tool-probe",
  "owner-mcp-server",
  "board-runner",
]);
export type ProcessLocationKind = z.infer<typeof ProcessLocationKindSchema>;

/** What a process kind is kept out of, as one table. */
export interface ProcessLocationRule {
  /**
   * Every location the kind is kept out of before grants, minus the tool's own
   * entry when `ownToolEntry` is set: the rule names the tool's own agent-tool
   * location (by RuntimeKind-like string) that this process may still enter,
   * because a tool loading its own configuration is ordinary operation.
   */
  deny: "all" | "none";
  /** The process may still enter its own tool's agent-tool entry. */
  ownToolEntry: boolean;
  /** Grants the bot received can remove locations from the deny set. */
  grantsApply: boolean;
}

/**
 * Which locations each kind of process is kept out of. One row per kind:
 * - `bot-command`: every location except those granted to the bot. The whole point
 *   of the table: a bot command on the owner's Mac reads no cloud credentials and
 *   writes no agent-tool folder, until the owner grants it.
 * - `agent-runtime`: every location except that tool's own entry and those granted
 *   to the bot. A Codex turn must read its own `~/.codex` instruction file and
 *   settings — that is how the tool runs — but no credentials and no other tool's
 *   folder.
 * - `tool-probe`: every location except that tool's own entry. A version or
 *   sign-in probe executes the tool's binary, which loads its own configuration;
 *   no grant can widen it because a probe acts for the owner, not for a bot.
 * - `owner-mcp-server` and `board-runner`: nothing added in this step. Both run
 *   under the host guardrail already; their rows exist so the table names every
 *   process kind the host starts.
 */
export const PROCESS_LOCATION_RULES: Record<ProcessLocationKind, ProcessLocationRule> = {
  "bot-command": { deny: "all", ownToolEntry: false, grantsApply: true },
  "agent-runtime": { deny: "all", ownToolEntry: true, grantsApply: true },
  "tool-probe": { deny: "all", ownToolEntry: true, grantsApply: false },
  "owner-mcp-server": { deny: "none", ownToolEntry: false, grantsApply: false },
  "board-runner": { deny: "none", ownToolEntry: false, grantsApply: false },
};

/**
 * The ids a process is kept out of, from the rules table: the locations the rule
 * denies, minus the tool's own entry when the rule keeps it open, minus those the
 * grants name. A grant for an id that is not in the table changes nothing.
 */
export function deniedLocationIds(input: {
  process: ProcessLocationKind;
  tool?: string;
  grants: string[];
  locations?: ProtectedLocation[];
}): string[] {
  const locations = input.locations ?? PROTECTED_LOCATIONS_DEFAULTS;
  const rule = PROCESS_LOCATION_RULES[input.process];
  if (rule.deny === "none") return [];
  const granted = new Set(input.grants);
  const keepsOwnEntry = (location: ProtectedLocation) =>
    rule.ownToolEntry && location.tool !== undefined && location.tool === input.tool;
  return locations
    .filter((location) => !keepsOwnEntry(location))
    .filter((location) => !(rule.grantsApply && granted.has(location.id)))
    .map((location) => location.id);
}
