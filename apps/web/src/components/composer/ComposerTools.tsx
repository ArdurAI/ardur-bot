import { Button, DropdownMenu, DropdownMenuTrigger } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { Plus } from "lucide-react";
import type { RefObject } from "react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ComposerMenuProps } from "./ComposerMenu";
import "./composer.css";

const ComposerMenu = lazy(() => import("./ComposerMenu"));
export function ComposerTools({
  disabled,
  fileInputRef,
  composerRef,
  onOpen,
  ...props
}: Omit<ComposerMenuProps, "shortcut" | "onFiles" | "open" | "onCloseFocus"> & {
  disabled?: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onOpen?: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const returnToComposer = useRef(false);
  const apple = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
  useEffect(() => {
    function upload(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() !== "u" ||
        !(apple ? event.metaKey : event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        disabled
      )
        return;
      // A Settings dialog owns its keyboard while it covers the thread.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      fileInputRef.current?.click();
    }
    window.addEventListener("keydown", upload);
    return () => window.removeEventListener("keydown", upload);
  }, [apple, disabled, fileInputRef]);
  return (
    <DropdownMenu
      open={open}
      onOpenChangeComplete={(value) => {
        if (!value && returnToComposer.current) {
          queueMicrotask(() => composerRef.current?.focus());
        }
      }}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          returnToComposer.current = false;
          setLoaded(true);
          onOpen?.();
        }
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label={t`Add files or photos`}
            className="size-8 shrink-0 rounded-full border border-border bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
          />
        }
      >
        <Plus size={16} strokeWidth={2} />
      </DropdownMenuTrigger>
      {loaded ? (
        <Suspense fallback={null}>
          <ComposerMenu
            {...props}
            open={open}
            onCloseFocus={() => (returnToComposer.current ? composerRef.current : true)}
            onSlash={() => {
              returnToComposer.current = true;
              props.onSlash();
            }}
            onSkill={(skill) => {
              returnToComposer.current = true;
              props.onSkill(skill);
            }}
            onMention={(mention) => {
              returnToComposer.current = true;
              props.onMention(mention);
            }}
            shortcut={apple ? "⌘U" : "Ctrl+U"}
            onFiles={() => fileInputRef.current?.click()}
          />
        </Suspense>
      ) : null}
    </DropdownMenu>
  );
}
