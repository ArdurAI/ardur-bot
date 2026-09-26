import { z } from "zod";

/** Beads splits labels on commas; a label never holds a comma, a line break or a null. */
export const BoardLabelSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^,\r\n\0]+$/);
