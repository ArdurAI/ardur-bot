import { z } from "zod";

/** Provider item tokens. Kept out of the board module so goal contracts do not load it. */
export const BoardItemIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
