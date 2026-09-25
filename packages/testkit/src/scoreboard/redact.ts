const MATRIX_DIAGNOSTIC_SECRET =
  /(?:postgres\S+|file:\/\/\S+|\/(?:Users|Volumes|home|tmp|private)\/\S+|\/var\/folders\/\S+)/g;

export function redactMatrixDiagnostic(text: string): string {
  return text.replace(MATRIX_DIAGNOSTIC_SECRET, "<redacted>");
}
