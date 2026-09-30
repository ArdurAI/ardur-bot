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

const locationPath = z
  .string()
  .min(2)
  .max(512)
  .refine(
    (value) => value.startsWith("~/") && value.length > 2,
    "A location path names a folder or file inside the home folder, written from it.",
  );

/**
 * One protected location. `paths` names folders or files written from the home
 * folder; `tool` is present exactly when `kind` is "agent-tool" (the schema enforces
 * this).
 */
export const ProtectedLocationSchema = z
  .object({
    id: z.string().min(1).max(64),
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
 * - Antigravity's `agy` CLI: no entry. Its vendor documentation
 *   (antigravity.google/docs/cli/settings, /cli/plugins and /cli/gcli-migration)
 *   describes `~/.gemini/antigravity-cli/` (settings, keybindings, plugins,
 *   skills), but that folder is shared with the Gemini CLI (`~/.gemini` is the
 *   Gemini CLI's own home), and this repository neither reads nor writes it
 *   anywhere. An Antigravity entry is listed as unconfirmed in the change that
 *   adds this table and lands when its folder is confirmed against the CLI's
 *   own configuration on a host.
 *
 * The credentials entries are the standard, documented configuration locations of
 * each tool on a macOS/Linux home folder.
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
];

/**
 * Locations the owner adds beyond the defaults. The policy is stored per host and
 * read back with parseProtectedLocationsPolicy. The schema refuses a custom id that
 * repeats a default id and a custom id used twice, so `protectedLocations` can
 * never return two locations with one id.
 */
export const ProtectedLocationsPolicyV1Schema = z
  .strictObject({
    version: z.literal(1),
    custom: z.array(ProtectedLocationSchema).max(64),
  })
  .superRefine((policy, ctx) => {
    const defaultIds = new Set(PROTECTED_LOCATIONS_DEFAULTS.map((location) => location.id));
    const seen = new Set<string>();
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
    }
  });
export type ProtectedLocationsPolicyV1 = z.infer<typeof ProtectedLocationsPolicyV1Schema>;

const PROTECTED_LOCATIONS_POLICY_EMPTY: ProtectedLocationsPolicyV1 = { version: 1, custom: [] };

/**
 * The stored policy for a host. Tolerant: unknown or invalid input — a policy from
 * another version, a malformed record, anything that is not a valid v1 policy —
 * reads as no custom locations, never throws.
 */
export function parseProtectedLocationsPolicy(raw: unknown): ProtectedLocationsPolicyV1 {
  const parsed = ProtectedLocationsPolicyV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : PROTECTED_LOCATIONS_POLICY_EMPTY;
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
