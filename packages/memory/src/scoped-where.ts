import type { DocumentListInput, MemoryAccess } from "@ardurbot/adapter-kit";
import { Prisma } from "@ardurbot/db";

/** Access is supplied by MemoryService.open, never by a list or read argument. */
export function authorizedDocumentWhere(access: MemoryAccess): Prisma.MemoryDocumentWhereInput {
  const botIds = access.botId
    ? access.botIds.filter((id) => id === access.botId)
    : [...access.botIds];
  const groups = ["direct", ...(access.groupIds ?? [])];
  const visibleGroups = access.runId
    ? groups.filter((id) => id === (access.groupId ?? "direct"))
    : groups;
  return {
    spaceId: access.spaceId,
    OR: [
      { scope: "space-shared" },
      { scope: "user", userId: access.userId },
      { scope: "bot", userId: access.userId, botId: { in: botIds } },
      {
        scope: "group",
        userId: access.userId,
        botId: { in: botIds },
        scopeKey: { in: botIds.flatMap((botId) => visibleGroups.map((id) => `${botId}:${id}`)) },
      },
    ],
  };
}

export function listedDocumentWhere(
  access: MemoryAccess,
  input: DocumentListInput,
): Prisma.MemoryDocumentWhereInput {
  return {
    AND: [
      authorizedDocumentWhere(access),
      ...(input.includeDeleted ? [] : [{ deletedAt: null }]),
      ...(input.scope ? [{ scope: input.scope }] : []),
      ...(input.groupId
        ? [
            {
              scope: "group",
              scopeKey: { in: access.botIds.map((id) => `${id}:${input.groupId}`) },
            },
          ]
        : []),
      ...(input.botId ? [{ botId: input.botId }] : []),
      ...(input.cursor ? [{ id: { gt: input.cursor } }] : []),
    ],
  };
}

const documentColumns = {
  id: Prisma.sql`"id"`,
  spaceId: Prisma.sql`"spaceId"`,
  userId: Prisma.sql`"userId"`,
  botId: Prisma.sql`"botId"`,
  scope: Prisma.sql`"scope"`,
  scopeKey: Prisma.sql`"scopeKey"`,
  deletedAt: Prisma.sql`"deletedAt"`,
} as const;

/** Compile only the predicates used by scoped reads; values stay bound parameters. */
export function documentWhereSql(where: Prisma.MemoryDocumentWhereInput): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  for (const [key, filter] of Object.entries(where)) {
    if (filter === undefined) continue;
    if (key === "AND" || key === "OR") {
      const parts = (
        Array.isArray(filter) ? filter : [filter]
      ) as Prisma.MemoryDocumentWhereInput[];
      if (parts.length === 0) continue;
      const joined = Prisma.join(parts.map(documentWhereSql), key === "AND" ? " AND " : " OR ");
      clauses.push(Prisma.sql`(${joined})`);
      continue;
    }
    if (!(key in documentColumns)) throw new Error(`Unsupported memory filter: ${key}`);
    const column = documentColumns[key as keyof typeof documentColumns];
    if (filter === null) clauses.push(Prisma.sql`${column} IS NULL`);
    else if (typeof filter === "string") clauses.push(Prisma.sql`${column} = ${filter}`);
    else if (typeof filter === "object" && "in" in filter && Array.isArray(filter.in))
      clauses.push(
        filter.in.length ? Prisma.sql`${column} IN (${Prisma.join(filter.in)})` : Prisma.sql`FALSE`,
      );
    else if (
      key === "id" &&
      typeof filter === "object" &&
      "gt" in filter &&
      typeof filter.gt === "string"
    )
      clauses.push(Prisma.sql`${column} COLLATE "C" > ${filter.gt} COLLATE "C"`);
    else throw new Error(`Unsupported memory filter: ${key}`);
  }
  return clauses.length ? Prisma.sql`(${Prisma.join(clauses, " AND ")})` : Prisma.sql`TRUE`;
}

type FilterRow = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string | null;
  scope: string;
  scopeKey: string | null;
  deletedAt: Date | null;
};

/** The relational fake interprets the exact Prisma where tree used in production. */
export function matchesDocumentWhere(
  row: FilterRow,
  where: Prisma.MemoryDocumentWhereInput,
): boolean {
  const supported = new Set([
    "AND",
    "OR",
    "id",
    "spaceId",
    "userId",
    "botId",
    "scope",
    "scopeKey",
    "deletedAt",
  ]);
  for (const key of Object.keys(where))
    if (!supported.has(key)) throw new Error(`Unsupported memory filter: ${key}`);
  const and = where.AND;
  if (and && !(Array.isArray(and) ? and : [and]).every((part) => matchesDocumentWhere(row, part)))
    return false;
  const or = where.OR;
  if (or && !(Array.isArray(or) ? or : [or]).some((part) => matchesDocumentWhere(row, part)))
    return false;
  for (const key of [
    "id",
    "spaceId",
    "userId",
    "botId",
    "scope",
    "scopeKey",
    "deletedAt",
  ] as const) {
    const filter = where[key];
    if (filter === undefined) continue;
    const value = row[key];
    if (filter === null || typeof filter !== "object") {
      if (value !== filter) return false;
    } else if ("in" in filter) {
      if (!Array.isArray(filter.in)) return false;
      const choices: readonly unknown[] = filter.in;
      if (!choices.includes(value)) return false;
    } else if ("gt" in filter) {
      if (typeof value !== "string" || typeof filter.gt !== "string" || value <= filter.gt)
        return false;
    } else {
      throw new Error(`Unsupported memory filter: ${key}`);
    }
  }
  return true;
}
