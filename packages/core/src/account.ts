import type { AccountInstructionContext } from "@ardurbot/contracts";

export function botInstructionText(
  bot: { instructions: string; name: string; title: string; description: string },
  context: AccountInstructionContext,
) {
  return [
    bot.instructions || `${bot.name}: ${bot.title}\n${bot.description}`,
    accountInstructionText(context),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Account hints are subordinate to the bot's explicit job and instructions. */
export function accountInstructionText(context: AccountInstructionContext): string {
  const hints = [
    context.displayName
      ? `Address the user as ${JSON.stringify(context.displayName)}, including greetings.`
      : "",
    context.workType
      ? `The user's work category is ${JSON.stringify(context.workType)}; use it only as a context hint.`
      : "",
    context.instructions,
  ].filter(Boolean);
  if (!hints.length) return "";
  return [
    "Account context (human-authored). Apply these preferences where compatible with the bot's own instructions above; the bot's own instructions take precedence on conflict.",
    ...hints,
    "End account context. The bot's own instructions retain precedence over conflicting account preferences.",
  ].join("\n\n");
}

/** Deliberately coarse parsing: no IP lookup, browser fingerprinting, or new dependency. */
export function sessionDeviceLabel(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").slice(0, 2048);
  if (/Electron\/|ArdurBotDesktop\//i.test(ua)) return "Desktop app";
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/i.test(ua)
      ? "iOS"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Macintosh|Mac OS X/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "";
  const browser = /Edg(?:e|A|iOS)?\//i.test(ua)
    ? "Edge"
    : /OPR\/|Opera/i.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//i.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//i.test(ua)
          ? "Chrome"
          : /Safari\//i.test(ua)
            ? "Safari"
            : "";
  return [browser, os].filter(Boolean).join(" · ") || "Unknown device";
}

export function accountPage<T>(rows: readonly T[], requestedPage: number) {
  const page = Math.max(0, Math.min(Math.floor(requestedPage), Math.ceil(rows.length / 10) - 1));
  return {
    page,
    rows: rows.slice(page * 10, page * 10 + 10),
    start: rows.length ? page * 10 + 1 : 0,
    end: Math.min(page * 10 + 10, rows.length),
    total: rows.length,
  };
}

export function devicePlatform(platform: string | null) {
  return (
    (
      {
        darwin: "macOS",
        win32: "Windows",
        linux: "Linux",
        ios: "iOS",
        android: "Android",
      } as Record<string, string>
    )[platform ?? ""] ??
    platform ??
    "—"
  );
}
export function accountDate(value: string | null, locale?: string) {
  return value
    ? new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
    : "—";
}
