import path from "node:path";
import type { Actor } from "@ardurbot/contracts";
import { IdePathSchema } from "@ardurbot/contracts";
import { eventFileChanges } from "@ardurbot/core";
import { ORPCError } from "@orpc/server";
import type { createIdeFiles } from "./ide-files.js";
import { ideHostPaths } from "./ide-files.js";
import type { RouterDeps } from "./router.js";

export function createIdeChanges(
  deps: Pick<RouterDeps, "prisma">,
  files: ReturnType<typeof createIdeFiles>,
) {
  return async (
    actor: Actor,
    input: { rootId: string; since: string; until: string; cursor?: string },
  ) => {
    const { root } = await files.resolve(actor, input.rootId);
    const since = new Date(input.since),
      until = new Date(input.until);
    if (
      !Number.isFinite(+since) ||
      !Number.isFinite(+until) ||
      +until <= +since ||
      +until - +since > 26 * 60 * 60 * 1000
    )
      throw new ORPCError("BAD_REQUEST");
    const events = await deps.prisma.event.findMany({
      where: {
        spaceId: actor.spaceId,
        thread: { userId: actor.userId, spaceId: actor.spaceId },
        createdAt: { gte: since, lt: until },
        type: { in: ["computer.file.changed", "command.finished"] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 201,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const items = events
      .slice(0, 200)
      .flatMap(eventFileChanges)
      .flatMap((change) => {
        let relative = change.path;
        if (root.kind === "host") {
          const paths = ideHostPaths(root.path);
          const absolute = paths.isAbsolute(change.path)
            ? change.path
            : change.cwd && paths.isAbsolute(change.cwd)
              ? paths.join(change.cwd, change.path)
              : null;
          if (!absolute) return [];
          relative = paths.relative(root.path, absolute).split(paths.sep).join("/");
        } else {
          if (change.computerId !== root.computerId) return [];
          if (change.cwd) {
            const cwd = change.cwd.replace(/^\/home\/(?:ardurbot|user\/ardurbot-home)(?:\/|$)/, "");
            if (cwd.startsWith("/")) return [];
            relative = path.posix.join(cwd, change.path);
          }
        }
        const parsed = IdePathSchema.safeParse(relative);
        if (!parsed.success || !relative) return [];
        const { computerId: _computer, cwd: _cwd, ...item } = change;
        return [{ ...item, path: relative }];
      });
    return { items, nextCursor: events.length > 200 ? events[199]!.id : null };
  };
}
