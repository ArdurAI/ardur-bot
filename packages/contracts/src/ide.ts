import * as z from "zod";

export const IDE_FILE_BYTES = 2 * 1024 * 1024;
export const IDE_DIFF_BYTES = 128 * 1024;
export const IdePathSchema = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === ".." || part === ".") &&
      !value.includes(":"),
    "Path escapes registered folders.",
  );
export const IdeRootSchema = z.object({
  id: z.string(),
  kind: z.enum(["host", "sandbox"]),
  name: z.string(),
  path: z.string(),
  computerId: z.string().nullable(),
  botId: z.string().nullable(),
});
export type IdeRoot = z.infer<typeof IdeRootSchema>;
export const IdeEntrySchema = z.object({
  path: IdePathSchema,
  kind: z.enum(["file", "dir"]),
  size: z.number().nonnegative(),
  executable: z.boolean().optional(),
});
export type IdeEntry = z.infer<typeof IdeEntrySchema>;
export const IdeFileSchema = z.object({
  path: IdePathSchema,
  content: z.string(),
  size: z.number().nonnegative(),
  executable: z.boolean().optional(),
  binary: z.boolean(),
  readOnly: z.boolean(),
  version: z.string(),
});
export type IdeFile = z.infer<typeof IdeFileSchema>;
export const IdeChangeSchema = z.object({
  id: z.string(),
  path: z.string(),
  botId: z.string(),
  runId: z.string().nullable(),
  createdAt: z.string(),
  source: z.enum(["tool", "command", "artifact"]),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type IdeChange = z.infer<typeof IdeChangeSchema>;

/** Selection stays plain text in the normal conversation, never an executable instruction. */
export function ideHandoffText(input: {
  path: string;
  startLine: number;
  endLine: number;
  selection: string;
  instruction: string;
}) {
  return `${input.instruction.trim()}\n\n${input.path}:${input.startLine}-${input.endLine}\n\n${input.selection}`;
}
