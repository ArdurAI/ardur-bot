import { BoardProblemSchema, isBoardAccessDenied } from "@ardurbot/contracts/board";
import { ORPCError } from "@orpc/server";

/** Preserve only the board's validated public problems across the session RPC bridge. */
export async function deviceReadResponse(response: Response | undefined, procedure: string) {
  if (!response) throw new Error("This view is unavailable from this device.");
  const result = (await response.json()) as { json: unknown };
  if (!response.ok) {
    if (procedure.startsWith("board/") && (response.status === 400 || response.status === 403)) {
      const problem = BoardProblemSchema.safeParse(
        result.json && typeof result.json === "object" && "data" in result.json
          ? result.json.data
          : undefined,
      );
      if (problem.success)
        throw new ORPCError(isBoardAccessDenied(problem.data) ? "FORBIDDEN" : "BAD_REQUEST", {
          message: problem.data.message,
          data: problem.data,
        });
    }
    throw new Error("This view is unavailable from this device.");
  }
  return result.json;
}
