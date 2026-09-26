export const MAX_REGISTERED_FOLDERS: number;
export function parseRegisteredFolders(
  text: string | null | undefined,
  isAbsolute: (path: string) => boolean,
): string[];
