/** Electron wraps rejected IPC errors. Only product sentences may cross into UI copy. */
export function knownActionError(error: unknown, messages: readonly string[], fallback: string) {
  const message =
    error instanceof Error
      ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
      : "";
  return messages.includes(message) ? message : fallback;
}
