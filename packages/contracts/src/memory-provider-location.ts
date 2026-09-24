/** Show only the destination host, never URL credentials, paths, queries, or tokens. */
export function memoryProviderHost(settings: Record<string, string>): string | null {
  try {
    const url = new URL(settings.baseUrl ?? settings.endpoint ?? "");
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.host
      : null;
  } catch {
    return null;
  }
}
