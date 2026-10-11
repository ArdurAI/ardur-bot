import type { ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";
import type { CatalogModelChoice, ModelConnectionChoice } from "@ardurbot/core";
import {
  availableCatalogModels,
  catalogModelChoices,
  searchCatalogModels,
  unavailableSubscriptionModel,
} from "@ardurbot/core";
import { Input, NativeSelect, NativeSelectOption } from "@ardurbot/ui-web";
import { Popover, PopoverContent, PopoverTrigger } from "@ardurbot/ui-web/components/ui/popover";
import { selectableRowClasses } from "@ardurbot/ui-web/lib/state-classes";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { CheckIcon, ChevronDown } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

function connectionLabel(choice: ModelConnectionChoice) {
  return choice.credential?.label ?? choice.entry.providerName ?? choice.entry.provider;
}

export default function CatalogModelPicker({
  catalog,
  credentials,
  provider,
  modelId,
  credentialId,
  onChange,
  disabled = false,
}: {
  catalog: ModelCatalogEntry[];
  credentials: ModelCredential[];
  provider: string;
  modelId: string;
  credentialId?: string;
  disabled?: boolean;
  onChange: (choice: ModelConnectionChoice | null) => void;
}) {
  const { t } = useLingui();
  const showAllId = useId();
  const [showAll, setShowAll] = useState(false);
  const allModels = useMemo(
    () => catalogModelChoices(catalog, credentials),
    [catalog, credentials],
  );
  const hasLimitedModels = allModels.some((model) =>
    model.connections.some((choice) =>
      unavailableSubscriptionModel([choice.entry], choice.entry.provider, choice.entry.id),
    ),
  );
  const models = useMemo(() => availableCatalogModels(allModels, showAll), [allModels, showAll]);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const active =
    models.find((model) =>
      model.connections.some(
        (choice) =>
          choice.entry.provider === provider &&
          choice.entry.id === modelId &&
          (!credentialId || choice.credential?.id === credentialId),
      ),
    ) ??
    models.find((model) =>
      model.connections.some(
        (choice) => choice.entry.provider === provider && choice.entry.placeholder,
      ),
    );
  const pending = models.find((model) => model.key === pendingKey);
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3">
      <ModelListPicker
        disabled={disabled}
        options={models}
        value={pending?.key ?? active?.key ?? ""}
        onChange={(key) => {
          const model = models.find((model) => model.key === key);
          if (!model) return;
          if (model.connections.length === 1) {
            setPendingKey(null);
            onChange(model.connections[0]!);
          } else {
            setPendingKey(key);
            onChange(null);
          }
        }}
      />
      {hasLimitedModels ? (
        <label
          htmlFor={showAllId}
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Input
            id={showAllId}
            type="checkbox"
            className="size-4"
            checked={showAll}
            onChange={(event) => setShowAll(event.target.checked)}
          />
          <Trans>Show all models</Trans>
        </label>
      ) : null}
      {pending ? (
        <NativeSelect
          aria-label={t`Choose connection`}
          value=""
          className="w-full"
          onChange={(event) => {
            const choice = pending.connections.find((choice) => choice.key === event.target.value);
            if (!choice) return;
            setPendingKey(null);
            onChange(choice);
          }}
        >
          <NativeSelectOption value="">{t`Choose connection`}</NativeSelectOption>
          {pending.connections.map((choice) => (
            <NativeSelectOption
              key={choice.key}
              value={choice.key}
              disabled={choice.requirement === "unavailable"}
            >
              {connectionLabel(choice)} ·{" "}
              {choice.requirement === "ready"
                ? t`Ready`
                : choice.requirement === "local-server"
                  ? t`Local server`
                  : choice.requirement === "sign-in"
                    ? t`Sign in`
                    : choice.requirement === "unavailable"
                      ? t`Unavailable`
                      : t`API key`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : null}
    </fieldset>
  );
}

function ModelListPicker({
  disabled,
  options,
  value,
  onChange,
}: {
  disabled: boolean;
  options: CatalogModelChoice[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useLingui();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = options.findIndex((option) => option.key === value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);
  const filteredOptions = useMemo(() => searchCatalogModels(options, query), [options, query]);

  useEffect(() => {
    setHighlightedIndex(selectedIndex);
    setOpen(false);
  }, [selectedIndex, value, disabled]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    searchRef.current?.focus();
  }, [open]);

  function choose(index: number) {
    const option = filteredOptions[index];
    if (!option) return;
    if (option.connections.every((choice) => choice.requirement === "unavailable")) return;
    onChange(option.key);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveHighlight(index: number) {
    const count = filteredOptions.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    setHighlightedIndex(next);
    const option = optionRefs.current[next];
    option?.scrollIntoView({ block: "nearest" });
    // Keep typing focus on the search field; only follow highlight when an option
    // already has focus (e.g. after Tab / prior option key nav).
    if (document.activeElement !== searchRef.current) {
      option?.focus();
    }
  }

  function activeOptionIndex() {
    return highlightedIndex >= 0 && highlightedIndex < filteredOptions.length
      ? highlightedIndex
      : 0;
  }

  function optionDomId(index: number) {
    return `${listboxId}-option-${index}`;
  }

  const activeDescendantId =
    filteredOptions.length > 0 ? optionDomId(activeOptionIndex()) : undefined;

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      moveHighlight(activeOptionIndex() + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      moveHighlight(activeOptionIndex() - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      moveHighlight(0);
    } else if (event.key === "End") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      moveHighlight(filteredOptions.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (filteredOptions.length === 0) return;
      choose(activeOptionIndex());
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
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
      setHighlightedIndex(Math.max(0, filteredOptions.length - 1));
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
      moveHighlight(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveHighlight(filteredOptions.length - 1);
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={t`Model`}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="mt-2 flex h-10 w-full items-center justify-between rounded-lg border border-input bg-transparent px-3 text-start text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        onKeyDown={onTriggerKeyDown}
      >
        <span className="min-w-0 truncate">{options[selectedIndex]?.label ?? t`Model`}</span>
        <span className="ml-3 shrink-0 text-muted-foreground" aria-hidden="true">
          <ChevronDown size={16} strokeWidth={1.8} />
        </span>
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          align="start"
          initialFocus={searchRef}
          finalFocus={triggerRef}
          className="w-(--anchor-width) max-h-(--available-height) gap-0 overflow-hidden p-0"
        >
          <input
            ref={searchRef}
            type="text"
            value={query}
            role="combobox"
            aria-label={t`Search models`}
            aria-controls={listboxId}
            aria-expanded={open}
            aria-autocomplete="list"
            aria-activedescendant={activeDescendantId}
            placeholder={t`Search`}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlightedIndex(0);
            }}
            onKeyDown={onSearchKeyDown}
            className="w-full border-b border-border bg-transparent px-3 py-2.5 text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/80"
          />
          <span role="status" className="sr-only">
            <Plural value={filteredOptions.length} one="# model" other="# models" />
          </span>
          <div
            id={listboxId}
            role="listbox"
            aria-label={t`Model options`}
            className="rk-scroll min-h-0 max-h-64 overflow-y-auto py-1"
          >
            {filteredOptions.map((option, index) => (
              <ModelOption
                key={option.key}
                option={option}
                optionDomId={optionDomId(index)}
                index={index}
                value={value}
                highlighted={highlightedIndex === index}
                optionRefs={optionRefs}
                choose={choose}
                onOptionKeyDown={onOptionKeyDown}
              />
            ))}
            {filteredOptions.length === 0 ? (
              <p className="px-3 py-2 text-[13px] text-muted-foreground">
                <Trans>No matching models</Trans>
              </p>
            ) : null}
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

function ModelOption({
  option,
  optionDomId,
  index,
  value,
  highlighted,
  optionRefs,
  choose,
  onOptionKeyDown,
}: {
  option: CatalogModelChoice;
  optionDomId: string;
  index: number;
  value: string;
  highlighted: boolean;
  optionRefs: RefObject<Array<HTMLButtonElement | null>>;
  choose: (index: number) => void;
  onOptionKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
}) {
  const { t } = useLingui();
  return (
    <button
      id={optionDomId}
      ref={(element) => {
        optionRefs.current[index] = element;
      }}
      type="button"
      role="option"
      aria-selected={option.key === value}
      disabled={option.connections.every((choice) => choice.requirement === "unavailable")}
      tabIndex={highlighted ? 0 : -1}
      className={selectableRowClasses(
        option.key === value,
        `flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-[13.5px] ${highlighted ? "bg-accent/50" : ""}`,
      )}
      onClick={() => choose(index)}
      onKeyDown={(event) => onOptionKeyDown(event, index)}
    >
      <span className="min-w-0 truncate">
        <span data-slot="model-label">{option.label}</span>
        {option.connections.some((choice) =>
          unavailableSubscriptionModel([choice.entry], choice.entry.provider, choice.entry.id),
        ) ? (
          <span className="block text-[12px] text-muted-foreground">
            <Trans>May not be available on your plan</Trans>
          </span>
        ) : null}
        <span className="block text-[12px] text-muted-foreground">
          {option.ready
            ? t`Ready`
            : option.connections
                .map(
                  (choice) =>
                    `${connectionLabel(choice)} · ${choice.requirement === "local-server" ? t`Local server` : choice.requirement === "sign-in" ? t`Sign in` : choice.requirement === "unavailable" ? t`Unavailable` : t`API key`}`,
                )
                .join(" · ")}
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-2">
        {option.key === value ? <CheckIcon className="size-4 shrink-0" /> : null}
      </div>
    </button>
  );
}
