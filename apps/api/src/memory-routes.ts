import {
  MemoryAccessError,
  MemoryConflictError,
  MemoryGenerationError,
} from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import {
  MEMORY_REVIEW_UNAVAILABLE_MESSAGE,
  MODEL_LOCALITY_DENIED_MESSAGE,
  RuntimePinError,
} from "@ardurbot/contracts";
import { MemoryRedactionError } from "@ardurbot/memory";
import { ORPCError } from "@orpc/server";

export function memoryContext(actor: Actor) {
  return {
    spaceId: actor.spaceId,
    userId: actor.userId,
    operationId: "memory",
    traceId: "memory",
    signal: new AbortController().signal,
  };
}
export async function memoryRpc<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof RuntimePinError && error.problem.code === "locality-denied")
      throw new ORPCError("FORBIDDEN", {
        message: MODEL_LOCALITY_DENIED_MESSAGE,
        data: { code: "locality-denied" },
      });
    if (error instanceof Error && error.message === MEMORY_REVIEW_UNAVAILABLE_MESSAGE)
      throw new ORPCError("BAD_REQUEST", { message: MEMORY_REVIEW_UNAVAILABLE_MESSAGE });
    if (error instanceof MemoryAccessError)
      throw new ORPCError("FORBIDDEN", { message: error.message });
    if (error instanceof MemoryConflictError || error instanceof MemoryGenerationError)
      throw new ORPCError("CONFLICT", { message: error.message });
    if (error instanceof MemoryRedactionError)
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    // Filenames, content, credentials, and provider responses never reach RPC errors.
    throw new ORPCError("BAD_REQUEST", {
      message: "Could not complete this memory operation. Check the document and try again.",
    });
  }
}
