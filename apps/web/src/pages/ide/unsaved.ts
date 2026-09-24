import { useEffect } from "react";
import { useBlocker } from "react-router-dom";
import { desktopBridge } from "../../lib/desktop";

export function useUnsavedChanges(dirty: boolean, label: string) {
  const blocker = useBlocker(dirty);
  useEffect(() => {
    void desktopBridge()
      ?.window.setUnsavedChanges?.(dirty)
      .catch(() => {});
    return () => {
      void desktopBridge()
        ?.window.setUnsavedChanges?.(false)
        .catch(() => {});
    };
  }, [dirty]);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm(label)) blocker.proceed();
    else blocker.reset();
  }, [blocker, label]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = label;
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, label]);
}
