/** xterm onData is Unicode; onBinary uses one JS code unit per byte. */
export function terminalInput(value: string, binary = false): Uint8Array {
  return binary
    ? Uint8Array.from(value, (character) => character.charCodeAt(0) & 255)
    : new TextEncoder().encode(value);
}
