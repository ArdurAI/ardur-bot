import type { IdeChange } from "@ardurbot/contracts";
import { useLingui } from "@lingui/react/macro";

export default function SideBySideDiff({ change }: { change: IdeChange }) {
  const { t } = useLingui();
  const before = change.before?.split("\n"),
    after = change.after?.split("\n");
  const rows = Math.max(before?.length ?? 0, after?.length ?? 0);
  return (
    <div className="h-full overflow-auto" data-testid="ide-diff">
      <div className="grid min-w-max grid-cols-2 text-xs">
        <div className="sticky top-0 border-b border-r border-border bg-card px-3 py-2">{t`Before`}</div>
        <div className="sticky top-0 border-b border-border bg-card px-3 py-2">{t`After`}</div>
        <pre className="border-r border-border py-2">
          {before ? (
            Array.from({ length: rows }, (_, index) => (
              <span
                key={`${index}-${before[index] ?? ""}`}
                className={`block min-h-5 px-3 ${before[index] !== after?.[index] && before[index] !== undefined ? "bg-destructive/10" : ""}`}
              >
                {before[index] ?? " "}
              </span>
            ))
          ) : (
            <span className="px-3 text-muted-foreground">{t`Not recorded`}</span>
          )}
        </pre>
        <pre className="py-2">
          {after ? (
            Array.from({ length: rows }, (_, index) => (
              <span
                key={`${index}-${after[index] ?? ""}`}
                className={`block min-h-5 px-3 ${after[index] !== before?.[index] && after[index] !== undefined ? "bg-success/10" : ""}`}
              >
                {after[index] ?? " "}
              </span>
            ))
          ) : (
            <span className="px-3 text-muted-foreground">{t`Not recorded`}</span>
          )}
        </pre>
      </div>
    </div>
  );
}
