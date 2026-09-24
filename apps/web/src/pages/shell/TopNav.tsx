import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { currentTopNavId, topNavShortcut, useTopNavItems } from "./top-nav";

export function TopNav() {
  const items = useTopNavItems();
  const { i18n } = useLingui();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const activeId = currentTopNavId(pathname, items);
  const current = items.find((item) => item.id === activeId);
  const title = current ? `${i18n._(current.label)} — Ardur Bot` : "Ardur Bot";
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest("[data-terminal-root]"))
      )
        return;
      const item = topNavShortcut(event, items);
      if (!item) return;
      event.preventDefault();
      navigate(item.to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, navigate]);
  return (
    <nav
      className="app-no-drag flex shrink-0 gap-0.5 rounded-lg bg-muted p-0.5"
      aria-label={i18n._(msg`Navigation`)}
    >
      {items.map((item, index) => (
        <Link
          key={item.id}
          to={item.to}
          aria-current={item.id === activeId ? "page" : undefined}
          aria-keyshortcuts={index < 4 ? `Meta+${index + 1} Control+${index + 1}` : undefined}
          className={`rounded-md px-2.5 py-1 text-xs focus-visible:outline-2 focus-visible:outline-ring ${item.id === activeId ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
        >
          {i18n._(item.label)}
        </Link>
      ))}
    </nav>
  );
}
