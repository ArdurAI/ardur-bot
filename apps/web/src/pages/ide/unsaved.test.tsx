// @vitest-environment jsdom

import { act, StrictMode, useContext, useState } from "react";
import { createRoot } from "react-dom/client";
import type { NavigateFunction, Navigator } from "react-router-dom";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  UNSAFE_NavigationContext,
  useNavigate,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installNavigationGuard } from "../../lib/navigation-guard";
import { useUnsavedChanges } from "./unsaved";

const desktop = vi.hoisted(() => ({ setUnsavedChanges: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/desktop", () => ({ desktopBridge: () => ({ window: desktop }) }));

let host: HTMLDivElement, renderer: ReturnType<typeof createRoot>, navigate: NavigateFunction;
let navigator: Navigator;
let stopNavigationGuard: () => void;

function Editor() {
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty, "Unsaved changes");
  return (
    <>
      <p>Editor {dirty ? "modified" : "saved"}</p>
      <button type="button" onClick={() => setDirty(!dirty)}>
        Edit or save
      </button>
    </>
  );
}

function Shell() {
  navigate = useNavigate();
  navigator = useContext(UNSAFE_NavigationContext).navigator;
  return (
    <>
      <Link to="/app">Bots</Link>
      <Link to="/app/ide">IDE</Link>
      <Routes>
        <Route path="/app/ide" element={<Editor />} />
        <Route path="*" element={<p>Bots page</p>} />
      </Routes>
    </>
  );
}

const click = async (selector: string) =>
  act(async () => host.querySelector<HTMLElement>(selector)!.click());
const visit = async (path: string, replace = false) => act(async () => navigate(path, { replace }));
const unload = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(false);
  stopNavigationGuard = installNavigationGuard();
  window.history.replaceState(null, "", "/app");
  host = document.createElement("div");
  document.body.append(host);
  renderer = createRoot(host);
  await act(async () =>
    renderer.render(
      <StrictMode>
        <BrowserRouter>
          <Shell />
        </BrowserRouter>
      </StrictMode>,
    ),
  );
  // Start with a real preceding router entry so Back/Forward exercise browser traversal.
  await visit("/app/ide");
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  stopNavigationGuard();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("IDE guard with BrowserRouter", () => {
  it("guards links and programmatic push/replace, then restores navigation after saving", async () => {
    const { push, replace } = navigator;
    await click("button");
    expect(unload()).toBe(true);
    expect(desktop.setUnsavedChanges).toHaveBeenLastCalledWith(true);
    await click('a[href="/app"]');
    await visit("/app", true);
    await visit("/app");
    expect(window.confirm).toHaveBeenCalledTimes(3);
    expect(window.location.pathname).toBe("/app/ide");
    expect(host.textContent).toContain("Editor modified");
    await click("button");
    expect(navigator.push).toBe(push);
    expect(navigator.replace).toBe(replace);
    expect(unload()).toBe(false);
    expect(desktop.setUnsavedChanges).toHaveBeenLastCalledWith(false);
    await visit("/app", true);
    expect(window.location.pathname).toBe("/app");
    expect(window.confirm).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "discards once for programmatic replace=%s and removes the guard on exit",
    async (replace) => {
      const { push, replace: original } = navigator;
      await click("button");
      vi.mocked(window.confirm).mockReturnValue(true);
      await visit("/app", replace);
      expect(host.textContent).toContain("Bots page");
      expect(window.confirm).toHaveBeenCalledOnce();
      expect(navigator.push).toBe(push);
      expect(navigator.replace).toBe(original);
      expect(unload()).toBe(false);
      expect(desktop.setUnsavedChanges).toHaveBeenLastCalledWith(false);
      await visit("/app/other");
      expect(window.confirm).toHaveBeenCalledOnce();
    },
  );

  it("cancels repeated Back without losing the buffer or growing history, then permits Back", async () => {
    await click("button");
    const length = window.history.length,
      index = window.history.state.idx;
    for (const expected of [1, 2]) {
      await act(async () => {
        window.history.back();
        await vi.waitFor(() => {
          expect(window.confirm).toHaveBeenCalledTimes(expected);
          expect(window.history.state.idx).toBe(index);
        });
      });
      expect(window.location.pathname).toBe("/app/ide");
      expect(host.textContent).toContain("Editor modified");
      expect(window.history.length).toBe(length);
    }
    vi.mocked(window.confirm).mockReturnValue(true);
    await act(async () => {
      navigate(-1);
      await vi.waitFor(() => expect(window.location.pathname).toBe("/app"));
    });
    expect(host.textContent).toContain("Bots page");
    expect(unload()).toBe(false);
  });

  it("cancels and accepts Forward without corrupting the preceding entry", async () => {
    await visit("/app");
    await act(async () => {
      window.history.back();
      await vi.waitFor(() => expect(window.location.pathname).toBe("/app/ide"));
    });
    await click("button");
    const index = window.history.state.idx;
    await act(async () => {
      window.history.forward();
      await vi.waitFor(() => {
        expect(window.confirm).toHaveBeenCalledOnce();
        expect(window.history.state.idx).toBe(index);
      });
    });
    expect(host.textContent).toContain("Editor modified");
    vi.mocked(window.confirm).mockReturnValue(true);
    await act(async () => {
      window.history.forward();
      await vi.waitFor(() => expect(window.location.pathname).toBe("/app"));
    });
    expect(host.textContent).toContain("Bots page");
  });

  it("preserves the editor and URL if an unindexed history entry is cancelled", async () => {
    await click("button");
    await act(async () => {
      window.history.replaceState(null, "", "/app");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(window.location.pathname).toBe("/app/ide");
    expect(host.textContent).toContain("Editor modified");
  });

  it("removes dirty IPC and browser listeners when unmounted without navigation", async () => {
    const { push, replace } = navigator;
    await click("button");
    await act(async () => renderer.render(null));
    expect(navigator.push).toBe(push);
    expect(navigator.replace).toBe(replace);
    expect(unload()).toBe(false);
    expect(desktop.setUnsavedChanges).toHaveBeenLastCalledWith(false);
  });
});
