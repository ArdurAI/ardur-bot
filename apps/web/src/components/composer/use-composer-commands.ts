import type { Routine } from "@ardurbot/contracts";
import type { ComposerActionId, ComposerCommand, ComposerSkill } from "@ardurbot/core";
import { composerCommands, resolveMentionPickerKey } from "@ardurbot/core";
import type { KeyboardEvent } from "react";
import { useCallback, useRef, useState } from "react";

export function useComposerCommands({
  skills,
  botAvailable,
  routines,
  draft,
  setDraft,
  onSkill,
  onAction,
  onRoutine,
  focus,
}: {
  skills: readonly ComposerSkill[];
  botAvailable: boolean;
  routines: readonly Routine[];
  draft: string;
  setDraft: (value: string) => void;
  onSkill: (skill: ComposerSkill) => void;
  onAction: (
    action: ComposerActionId,
    argument?: string,
  ) => void | boolean | Promise<void> | Promise<boolean>;
  onRoutine: (id: string) => void | boolean | Promise<void> | Promise<boolean>;
  focus: () => void;
}) {
  const busy = useRef(false);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [skillsOnly, setSkillsOnly] = useState(false);
  const [activeId, setActive] = useState("");
  const [aria, setAria] = useState<{ listId?: string; optionId?: string }>({});
  const syncAria = useCallback((value: { listId?: string; optionId?: string }) => {
    setAria((current) =>
      current.listId === value.listId && current.optionId === value.optionId ? current : value,
    );
  }, []);
  const rows =
    query === null ? [] : composerCommands({ query, skills, routines, skillsOnly, botAvailable });
  const index = Math.max(
    0,
    rows.findIndex((row) => row.id === activeId),
  );
  const active = rows[index];
  function update(value: string) {
    if (value.startsWith("/")) setLoaded(true);
    setQuery(/^\/([^\n]*)$/.exec(value)?.[1] ?? null);
    setActive("");
    setSkillsOnly(false);
  }
  function open(onlySkills = false) {
    setLoaded(true);
    setSkillsOnly(onlySkills);
    setQuery("");
    setActive("");
    focus();
  }
  async function run(action: () => void | boolean | Promise<void> | Promise<boolean>) {
    if (busy.current) return;
    busy.current = true;
    try {
      const result = await action();
      if (result !== false && latestDraft.current === draft && draft.startsWith("/")) setDraft("");
    } finally {
      busy.current = false;
    }
  }
  function select(command: ComposerCommand) {
    if (command.kind === "action" && (command.action === "skills" || command.action === "help")) {
      if (draft.startsWith("/")) setDraft("");
      open(command.action === "skills");
      return;
    }
    const argument =
      command.kind === "action" && command.action === "remember"
        ? (/^\/remember\s+([\s\S]+)$/.exec(draft)?.[1]?.trim() ?? "")
        : "";
    setQuery(null);
    if (command.kind === "action" && command.action === "remember" && !argument) {
      setDraft("/remember ");
      focus();
      return;
    }
    if (command.kind === "skill") onSkill(command.skill);
    else if (command.kind === "routine") void run(() => onRoutine(command.routine.id));
    else void run(() => onAction(command.action, argument));
    focus();
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (query === null) return false;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return true;
    if (event.key === "Escape") {
      event.preventDefault();
      setQuery(null);
      return true;
    }
    const result = resolveMentionPickerKey({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: false,
      optionCount: rows.length,
      highlightedIndex: index,
    });
    if (result.type === "move") {
      event.preventDefault();
      setActive(rows[result.index]?.id ?? "");
      return true;
    }
    if (result.type === "complete" && active) {
      event.preventDefault();
      select(active);
      return true;
    }
    return false;
  }
  /** Enter after completing /remember's argument also works if the picker was dismissed. */
  function submitCommand() {
    if (!botAvailable) return false;
    const match = /^\/remember\s+([\s\S]+)$/.exec(draft);
    if (!match?.[1]?.trim()) return false;
    const text = match[1].trim();
    void run(() => onAction("remember", text));
    setQuery(null);
    return true;
  }
  return {
    aria,
    syncAria,
    loaded,
    rows,
    activeId: active?.id,
    setActive,
    open,
    update,
    select,
    keyDown,
    submitCommand,
    close: () => setQuery(null),
    isOpen: query !== null,
  };
}
