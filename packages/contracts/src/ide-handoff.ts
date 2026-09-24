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
