/** Terminal output is untrusted. Only explicit, credential-free web URLs are navigation candidates. */
export function terminalWebLink(text: string): string | null {
  if (text.length > 8192 || !/^https?:\/\//i.test(text) || /[\s\\]/u.test(text)) return null;
  for (const char of text) if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) return null;
  try {
    const url = new URL(text);
    const authority = /^https?:\/\/([^/?#]+)/i.exec(text)?.[1];
    if (!authority || authority.includes("@")) return null;
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      !["http:", "https:"].includes(url.protocol)
    )
      return null;
    return text;
  } catch {
    return null;
  }
}
