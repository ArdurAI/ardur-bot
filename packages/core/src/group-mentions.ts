export type GroupMemberRef = {
  id: string;
  name: string;
};

const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_-]{0,39})/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasMentionToken(text: string, name: string): boolean {
  const normalized = name.trim();
  if (!normalized) return false;
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_-])@${escapeRegExp(normalized)}(?![\\p{L}\\p{N}_-])`,
    "iu",
  ).test(text);
}

/**
 * Words that can open a message before the addressed name ("hey Chief ...").
 * Without one of these, an "@" or punctuation must close the address clause so
 * a name used as a subject ("Radiant said Chief was wrong") never reroutes.
 */
const ADDRESS_OPENERS = new Set(["hey", "hi", "hello", "yo", "ok", "okay", "so"]);

/**
 * Members a message addresses by name at its start, with or without "@".
 *
 * Exact rule: after optional leading whitespace and one optional opener word,
 * the message must begin with one or more whole member names (case-insensitive,
 * same Unicode boundaries as hasMentionToken, longest name first), joined by
 * commas, "and", "&" or "+". The address then counts when it is closed by
 * punctuation (, ; : ! ?), by the end of the message, by an "@" on any matched
 * name, or by the leading opener. Anything else leaves the message unaddressed.
 */
export function resolveAddressedBotIds(input: {
  text: string;
  members: GroupMemberRef[];
}): string[] {
  const candidates = input.members
    .map((member) => ({ id: member.id, name: member.name.trim() }))
    .filter((member) => member.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  if (!candidates.length) return [];

  const matchName = (rest: string) => {
    for (const candidate of candidates) {
      const match = new RegExp(
        `^(@?)${escapeRegExp(candidate.name)}(?![\\p{L}\\p{N}_-])`,
        "iu",
      ).exec(rest);
      if (match) return { id: candidate.id, length: match[0].length, mentioned: match[1] === "@" };
    }
    return undefined;
  };

  let rest = input.text.trimStart();
  let openerSeen = false;
  const opener = /^(\p{L}+)\s+/u.exec(rest);
  if (opener?.[1] && ADDRESS_OPENERS.has(opener[1].toLowerCase())) {
    openerSeen = true;
    rest = rest.slice(opener[0].length);
  }

  const addressed: string[] = [];
  let terminated = false;
  for (;;) {
    const name = matchName(rest);
    if (!name) break;
    if (!addressed.includes(name.id)) addressed.push(name.id);
    if (name.mentioned) terminated = true;
    rest = rest.slice(name.length).trimStart();
    if (!rest) {
      terminated = true;
      break;
    }
    if (rest.startsWith(",")) {
      const past = rest.slice(1).trimStart();
      if (matchName(past)) {
        rest = past;
        continue;
      }
      terminated = true;
      break;
    }
    if (/^[;:!?]/.test(rest)) {
      terminated = true;
      break;
    }
    const conjunction = /^(?:and(?![\p{L}\p{N}_-])|&|\+)\s*/iu.exec(rest);
    if (conjunction) {
      const past = rest.slice(conjunction[0].length);
      if (matchName(past)) {
        rest = past;
        continue;
      }
    }
    break;
  }

  return addressed.length > 0 && (terminated || openerSeen) ? addressed : [];
}

export function parseMentionNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    if (name) names.add(name.toLowerCase());
  }
  return [...names];
}

export function resolveGroupTargetBotIds(input: {
  text: string;
  members: GroupMemberRef[];
  /** Bot ids from typed mention chips (non-members are ignored for wake). */
  explicitMentions?: string[];
}): string[] {
  const membersById = new Map(input.members.map((member) => [member.id, member]));
  const targetIds = new Set<string>();

  for (const mentionId of input.explicitMentions ?? []) {
    // Out-of-chat bots stay as @Name in the prompt; only members are woken here.
    if (membersById.has(mentionId)) targetIds.add(mentionId);
  }

  if (hasMentionToken(input.text, "everyone")) {
    for (const member of input.members) targetIds.add(member.id);
  } else {
    for (const member of input.members) {
      if (hasMentionToken(input.text, member.name)) targetIds.add(member.id);
    }
  }

  if (targetIds.size === 0 && input.members[0]) {
    targetIds.add(input.members[0].id);
  }

  return [...targetIds];
}

export function inferHandoffTargetName(prompt: string): string | undefined {
  const handoffMatch =
    /hand(?:\s+this|\s+off|\s+it)?\s+to\s+@?([A-Za-z0-9][A-Za-z0-9_-]{0,39})/i.exec(prompt) ??
    /@([A-Za-z0-9][A-Za-z0-9_-]{0,39})\s+take/i.exec(prompt);
  return handoffMatch?.[1];
}

export function inferHandoffTargetBotId(
  prompt: string,
  members: GroupMemberRef[],
): string | undefined {
  const handedTo = members.find((member) => {
    const escaped = escapeRegExp(member.name.trim());
    return escaped
      ? new RegExp(`\\bto\\s+@?${escaped}(?![\\p{L}\\p{N}_-])`, "iu").test(prompt)
      : false;
  });
  if (handedTo) return handedTo.id;
  const mentioned = members.find((member) => hasMentionToken(prompt, member.name));
  if (mentioned) return mentioned.id;
  const name = inferHandoffTargetName(prompt)?.toLowerCase();
  return name ? members.find((member) => member.name.toLowerCase() === name)?.id : undefined;
}
