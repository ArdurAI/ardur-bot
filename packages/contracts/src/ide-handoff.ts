export const IDE_SELECTION_CHARS = 32_000;

/** Selection stays plain text in the normal conversation, never an executable instruction. */
export function ideHandoffText(input: {
  path: string;
  startLine: number;
  endLine: number;
  selection: string;
  instruction: string;
}) {
  const shortened = input.selection.length > IDE_SELECTION_CHARS;
  return `${input.instruction.trim()}\n\n${input.path}:${input.startLine}-${input.endLine}\n\n${input.selection.slice(0, IDE_SELECTION_CHARS)}${shortened ? "\n\nSelection shortened to 32,000 characters." : ""}`;
}
