import { useLingui } from "@lingui/react/macro";
import { ChevronDown } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { SettingsRow } from "../../components/SettingsRow";
import { getActiveUiLocale, setUiLocale } from "../../lib/i18n";
import type { UiLocale } from "../../lib/ui-locale";
import { UI_LOCALE_LABELS, UI_LOCALES } from "../../lib/ui-locale";

export function AccountLanguage() {
  const { t } = useLingui();
  const [locale, setLocale] = useState<UiLocale>(() => getActiveUiLocale());
  const request = useRef(0);
  function chooseLocale(next: UiLocale) {
    if (next === locale) return;
    const id = ++request.current;
    setLocale(next);
    void setUiLocale(next).then((activated) => {
      if (id === request.current) setLocale(activated);
    });
  }
  return (
    <SettingsRow label={t`Language`}>
      <UiLocalePicker value={locale} onChange={chooseLocale} />
    </SettingsRow>
  );
}

function UiLocalePicker({
  value,
  onChange,
}: {
  value: UiLocale;
  onChange: (locale: UiLocale) => void;
}) {
  const { t } = useLingui();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = Math.max(0, UI_LOCALES.indexOf(value));
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);

  useEffect(() => {
    setHighlightedIndex(selectedIndex);
    setOpen(false);
  }, [selectedIndex, value]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[highlightedIndex]?.focus();
  }, [highlightedIndex, open]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  function choose(index: number) {
    const next = UI_LOCALES[index];
    if (!next) return;
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveHighlight(index: number) {
    setHighlightedIndex((index + UI_LOCALES.length) % UI_LOCALES.length);
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex(UI_LOCALES.length - 1);
    }
  }

  function onOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setHighlightedIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHighlightedIndex(UI_LOCALES.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(index);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div ref={rootRef} className="relative mt-3">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        data-testid="ui-locale-select"
        aria-label={t`Language`}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex h-9 w-full items-center justify-between rounded-lg border border-input bg-transparent px-3 text-start text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="min-w-0 truncate">{UI_LOCALE_LABELS[value]}</span>
        <span className="ml-3 shrink-0 text-muted-foreground" aria-hidden="true">
          <ChevronDown size={16} strokeWidth={1.8} />
        </span>
      </button>
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t`Language`}
          className="rk-scroll absolute left-0 right-0 top-full z-20 mt-1 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {UI_LOCALES.map((code, index) => (
            <button
              key={code}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="option"
              aria-selected={code === value}
              tabIndex={index === highlightedIndex ? 0 : -1}
              className={`w-full rounded-md px-2 py-1.5 text-start text-sm outline-none hover:bg-accent focus-visible:bg-accent ${
                code === value ? "bg-accent" : ""
              }`}
              onClick={() => choose(index)}
              onKeyDown={(event) => onOptionKeyDown(event, index)}
            >
              {UI_LOCALE_LABELS[code]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
