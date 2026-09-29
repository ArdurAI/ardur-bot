// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BotAvatar } from "./bot-avatar.js";

const media = { matches: false, listeners: new Set<() => void>() };
const observed: Array<
  (entries: Array<Pick<IntersectionObserverEntry, "target" | "isIntersecting">>) => void
> = [];

beforeAll(() => {
  window.matchMedia = vi.fn(() => ({
    get matches() {
      return media.matches;
    },
    addEventListener: (_: string, listener: () => void) => media.listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => media.listeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (typeof observed)[number]) {
        observed.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  media.matches = false;
  delete document.documentElement.dataset.motion;
});

async function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  return host;
}

const moving = (host: Element) => host.querySelectorAll('[class^="ardurbot-seal-"]').length;

describe("seal motion on the web", () => {
  it("animates a busy seal and adds its pack's CSS to the page once", async () => {
    const host = await render(
      <>
        <BotAvatar color="#2F4A7A" phase="thinking" size={112} />
        <BotAvatar color="#9A3B1E" phase="thinking" size={112} />
      </>,
    );
    expect(host.querySelectorAll(".ardurbot-seal-landscapes-wonders-thinking-ring")).toHaveLength(
      2,
    );
    expect(
      host.querySelectorAll(".ardurbot-seal-landscapes-wonders-thinking-aurora-2"),
    ).toHaveLength(2);
    expect(
      document.head.querySelectorAll('style[data-ardurbot-seal-scenes="landscapes-wonders"]'),
    ).toHaveLength(1);
  });

  it("applies no animation classes under reduced motion and keeps the still pose", async () => {
    media.matches = true;
    const host = await render(<BotAvatar color="#2F4A7A" phase="searching" size={112} />);
    expect(moving(host)).toBe(0);
    expect(host.querySelector('path[transform="rotate(-40 50 50)"]')).not.toBeNull();
  });

  it("follows the OS and the account's Reduce motion setting as they change", async () => {
    const host = await render(<BotAvatar color="#2F4A7A" phase="waiting" size={40} />);
    expect(moving(host)).toBeGreaterThan(0);
    await act(async () => {
      document.documentElement.dataset.motion = "reduced";
      await Promise.resolve();
    });
    expect(moving(host)).toBe(0);
    await act(async () => {
      delete document.documentElement.dataset.motion;
      await Promise.resolve();
    });
    expect(moving(host)).toBeGreaterThan(0);
    await act(async () => {
      media.matches = true;
      for (const listener of media.listeners) listener();
    });
    expect(moving(host)).toBe(0);
  });

  it("pauses a seal scrolled out of view until it returns", async () => {
    const host = await render(<BotAvatar color="#2F4A7A" phase="starting" size={40} />);
    const seal = host.querySelector(".ardurbot-bot-avatar")!;
    const report = observed.at(-1)!;
    report([{ target: seal, isIntersecting: false }]);
    expect(seal.hasAttribute("data-offscreen")).toBe(true);
    report([{ target: seal, isIntersecting: true }]);
    expect(seal.hasAttribute("data-offscreen")).toBe(false);
  });

  it("draws only the ring and badge bands over a chosen picture", async () => {
    const host = await render(
      <BotAvatar color="data:image/png;base64,abc" phase="waiting" size={40} />,
    );
    expect(host.querySelector("img")).not.toBeNull();
    const shapes = [...host.querySelectorAll("svg > *")].map((shape) => shape.tagName);
    expect(shapes).toEqual(["circle", "circle"]);
    expect(host.querySelector('circle[fill="var(--warning)"]')).not.toBeNull();
  });

  it("draws nothing over the disc when idle", async () => {
    const host = await render(<BotAvatar color="#2F4A7A" label="Atlas" status="idle" size={40} />);
    expect(host.querySelector("svg")).toBeNull();
    expect(host.textContent).toBe("A");
  });
});
