export function formatCommandTime(
  iso: string | null | undefined,
  now: Date,
  locale?: string,
): string | null {
  if (!iso || typeof iso !== "string" || iso.trim() === "") {
    return null;
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const isSameYear = date.getFullYear() === now.getFullYear();
  const isToday =
    isSameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();

  const options: Intl.DateTimeFormatOptions = isToday
    ? { hour: "numeric", minute: "2-digit" }
    : {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(isSameYear ? {} : { year: "numeric" }),
      };

  try {
    const targetLocale = locale && locale.trim() !== "" ? locale : undefined;
    return new Intl.DateTimeFormat(targetLocale, options).format(date);
  } catch {
    return null;
  }
}
