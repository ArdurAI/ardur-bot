import type { AgentSkillCatalogEntry, Routine, TaughtSkill } from "@ardurbot/contracts";
import { SLASH_ACTIONS } from "./composer-slash.js";

export const COMPOSER_ACTIONS = [
  { id: "new", description: "Start a new chat" },
  { id: "stop", description: "Stop the current run" },
  { id: "compare", description: "Compare bots" },
  { id: "remember", description: "Save a memory note" },
  { id: "routine", description: "Open routines" },
  { id: "skills", description: "Choose a taught skill" },
  { id: "model", description: "Change this bot’s pin" },
  { id: "settings", description: "Open Settings" },
  { id: "help", description: "Show slash commands" },
] as const;

export type ComposerActionId =
  | (typeof COMPOSER_ACTIONS)[number]["id"]
  | (typeof SLASH_ACTIONS)[number]["id"];
export type ComposerSkill = Pick<AgentSkillCatalogEntry, "id" | "name" | "description">;
export type ComposerCommand = {
  id: string;
  name: string;
  description: string;
} & (
  | { kind: "action"; action: ComposerActionId }
  | { kind: "skill"; skill: ComposerSkill }
  | { kind: "routine"; routine: Pick<Routine, "id" | "name" | "botId"> }
);

export function composerSkills(
  catalog: readonly AgentSkillCatalogEntry[],
  taught: readonly TaughtSkill[],
  botId?: string,
): ComposerSkill[] {
  const skills = new Map<string, ComposerSkill>();
  for (const skill of catalog) {
    if (!skill.botId || skill.botId === botId) skills.set(skill.name.toLowerCase(), skill);
  }
  for (const skill of taught) {
    if (skill.status === "saved" && (!botId || skill.botId === botId)) {
      skills.set(skill.name.toLowerCase(), {
        id: skill.id,
        name: skill.name,
        description: skill.goal,
      });
    }
  }
  return [...skills.values()];
}

/** A shared catalog; platform views translate descriptions and own navigation. */
export function composerCommands(input: {
  query: string;
  skills: readonly ComposerSkill[];
  routines: readonly Pick<Routine, "id" | "name" | "botId" | "prompt">[];
  botCount?: number;
  compareAvailable?: boolean;
  skillsOnly?: boolean;
  botAvailable?: boolean;
}): ComposerCommand[] {
  const rows: ComposerCommand[] = [];
  if (!input.skillsOnly) {
    for (const action of COMPOSER_ACTIONS) {
      if (
        input.botAvailable === false &&
        ["new", "remember", "routine", "model"].includes(action.id)
      )
        continue;
      if (action.id === "compare" && (!input.compareAvailable || (input.botCount ?? 0) < 2))
        continue;
      rows.push({
        kind: "action",
        id: action.id,
        action: action.id,
        name: `/${action.id}`,
        description: action.description,
      });
    }
    for (const action of SLASH_ACTIONS) {
      rows.push({
        kind: "action",
        id: action.id,
        action: action.id,
        name: `/${action.id}`,
        description: action.label,
      });
    }
  }
  for (const skill of input.skills) {
    rows.push({
      kind: "skill",
      id: `skill:${skill.id}`,
      name: `/${skill.name}`,
      description: skill.description,
      skill,
    });
  }
  if (!input.skillsOnly) {
    for (const routine of input.routines) {
      rows.push({
        kind: "routine",
        id: `routine:${routine.id}`,
        name: `/${routine.name}`,
        description: routine.prompt,
        routine,
      });
    }
  }
  const query = input.query.trim().toLowerCase();
  // Arguments belong to /remember, rather than to catalog filtering.
  if (/^remember\s/.test(input.query)) return rows.filter((row) => row.id === "remember");
  return rows.filter(
    (row) => !query || `${row.name} ${row.description}`.toLowerCase().includes(query),
  );
}

export function canAddComposerFolder(desktop: boolean, computerProvider?: string): boolean {
  return desktop && computerProvider === "desktop";
}
