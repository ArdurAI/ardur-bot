// @vitest-environment jsdom
import type { IdeChange } from "@ardurbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ changes: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { ide: api } }));
vi.mock("@ardurbot/ui-web", () => ({ Button: "button" }));
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({}) }));

import { useChanges } from "./changes";

const change = (id: string): IdeChange => ({
  id,
  path: `${id}.txt`,
  botId: "bot",
  runId: "run",
  createdAt: "2026-01-02T12:00:00Z",
  source: "command",
  before: "old",
  after: "new",
});
const onError = vi.fn();
const onFilesChanged = vi.fn();
let result: ReturnType<typeof useChanges>;
let host: HTMLDivElement;
let renderer: ReturnType<typeof createRoot>;
function Harness({ rootId, enabled }: { rootId: string; enabled: boolean }) {
  result = useChanges(rootId, enabled, onError, onFilesChanged);
  return null;
}
async function render(enabled = true, rootId = "root") {
  await act(async () => renderer.render(<Harness rootId={rootId} enabled={enabled} />));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-02T12:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.clearAllMocks();
  api.changes.mockReset().mockResolvedValue({ items: [change("first")], nextCursor: "page-2" });
  host = document.createElement("div");
  renderer = createRoot(host);
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Changes refresh", () => {
  it.each([null, "older-cursor"])(
    "keeps a missing interval reachable after a disjoint head replaces exhausted cursor %s",
    async (oldCursor) => {
      const page = (high: number, count: number) =>
        Array.from({ length: count }, (_, index) => change(String(high - index)));
      api.changes.mockResolvedValueOnce({ items: page(200, 2), nextCursor: "old-page" });
      await render();
      api.changes.mockResolvedValueOnce({ items: page(198, 1), nextCursor: oldCursor });
      await act(async () => result.more!());
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(30_000);
      });
      api.changes.mockResolvedValueOnce({ items: page(600, 200), nextCursor: "gap-1" });
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(result.items.map(({ id }) => id)).toContain("198");
      expect(result.more).toBeDefined();
      api.changes.mockResolvedValueOnce({ items: page(400, 200), nextCursor: "gap-2" });
      await act(async () => result.more!());
      expect(api.changes).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "gap-1" }));
      expect(result.items.map(({ id }) => id)).toEqual(page(600, 403).map(({ id }) => id));
      api.changes.mockResolvedValueOnce({ items: page(200, 3), nextCursor: oldCursor });
      await act(async () => result.more!());
      expect(api.changes).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "gap-2" }));
      expect(result.items.map(({ id }) => id)).toEqual(page(600, 403).map(({ id }) => id));
      expect(Boolean(result.more)).toBe(oldCursor !== null);
    },
  );
  it("does not let an old in-flight page close a newly discovered gap", async () => {
    await render();
    let resolve!: (page: { items: IdeChange[]; nextCursor: null }) => void;
    api.changes.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.more!();
    });
    api.changes.mockResolvedValueOnce({ items: [change("new")], nextCursor: "gap" });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await act(async () => {
      resolve({ items: [change("older")], nextCursor: null });
      await pending;
    });
    expect(result.more).toBeDefined();
    api.changes.mockResolvedValueOnce({ items: [change("first")], nextCursor: "page-2" });
    await act(async () => result.more!());
    expect(api.changes).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "gap" }));
  });
  it("retains pagination through an unchanged head with no matching changes", async () => {
    api.changes.mockResolvedValue({ items: [], nextCursor: "page-2" });
    await render();
    api.changes.mockResolvedValueOnce({ items: [change("older")], nextCursor: "page-3" });
    await act(async () => result.more!());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await act(async () => result.more!());
    expect(api.changes).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-3" }));
  });
  it("invalidates file listings after commands or runs without diffs, including with the drawer closed", async () => {
    api.changes.mockResolvedValue({ items: [], nextCursor: null });
    await render();
    onFilesChanged.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(onFilesChanged).toHaveBeenCalledOnce();
    await render(false);
    onFilesChanged.mockClear();
    const calls = api.changes.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(onFilesChanged).toHaveBeenCalledOnce();
    expect(api.changes).toHaveBeenCalledTimes(calls);
  });
  it("refreshes directory caches on visibility return even with the drawer closed", async () => {
    await render(false);
    onFilesChanged.mockClear();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(onFilesChanged).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(onFilesChanged).toHaveBeenCalledOnce();
  });
  it("preserves loaded older pages and their cursor on an unchanged head refresh", async () => {
    await render();
    api.changes.mockResolvedValueOnce({ items: [change("older")], nextCursor: "page-3" });
    await act(async () => result.more!());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(result.items.map(({ id }) => id)).toEqual(["first", "older"]);
    await act(async () => result.more!());
    expect(api.changes).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-3" }));
  });
  it("merges a new head with a pagination request crossing the poll without duplicates", async () => {
    await render();
    let resolve!: (page: { items: IdeChange[]; nextCursor: string | null }) => void;
    api.changes.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.more!();
    });
    api.changes.mockResolvedValue({
      items: [change("new"), change("first")],
      nextCursor: "page-2",
    });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await act(async () => {
      resolve({ items: [change("first"), change("older")], nextCursor: null });
      await pending;
    });
    expect(result.items.map(({ id }) => id)).toEqual(["new", "first", "older"]);
    expect(result.more).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(result.more).toBeUndefined();
    expect(result.items.map(({ id }) => id)).toEqual(["new", "first", "older"]);
  });
  it("ignores an older page after switching roots", async () => {
    await render();
    let resolve!: (page: { items: IdeChange[]; nextCursor: null }) => void;
    api.changes.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.more!();
    });
    api.changes.mockResolvedValue({ items: [change("other")], nextCursor: null });
    await render(true, "other-root");
    await act(async () => {
      resolve({ items: [change("stale")], nextCursor: null });
      await pending;
    });
    expect(result.items.map(({ id }) => id)).toEqual(["other"]);
  });
  it("resets loaded pages and cursor when the local day changes", async () => {
    await render();
    api.changes.mockResolvedValueOnce({ items: [change("older")], nextCursor: "page-3" });
    await act(async () => result.more!());
    vi.setSystemTime(new Date("2026-01-03T12:00:00Z"));
    api.changes.mockResolvedValue({ items: [change("today")], nextCursor: null });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(result.items.map(({ id }) => id)).toEqual(["today"]);
    expect(result.more).toBeUndefined();
  });
});
