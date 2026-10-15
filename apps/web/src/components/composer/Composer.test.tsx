// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ComponentProps, ReactNode } from "react";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  integrations: vi.fn(),
  summary: vi.fn(),
  servers: vi.fn(),
  send: vi.fn(),
  action: vi.fn(),
  routine: vi.fn(),
  stop: vi.fn(),
  manage: vi.fn(),
  open: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    integrations: { list: fake.integrations },
    connectors: { summary: fake.summary },
    mcp: { servers: { list: fake.servers } },
  },
  selectedSpaceId: () => "space",
}));
vi.mock("../../lib/auth", () => ({ authClient: {} }));
vi.mock("../../pages/CompareStart", () => ({
  CompareStart: ({ open, botId, text }: { open?: boolean; botId: string; text?: string }) =>
    open ? <div role="dialog" aria-label="Compare with…">{`${botId}: ${text}`}</div> : null,
}));
const translate = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: translate }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));

import { refreshIntegrationCatalog } from "../../lib/integration-catalog-query";
import { Composer } from "../../pages/Shell";
import type { PendingAttachment } from "./attachments";
import { prepareComposerAttachments } from "./attachments";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage = null;
      close() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  URL.createObjectURL = vi.fn().mockReturnValue("blob:photo");
  URL.revokeObjectURL = vi.fn();
  fake.integrations.mockResolvedValue({
    catalog: [{ id: "reports", name: "Reports", authKind: "token" }],
    connections: [{ id: "connection", catalogId: "reports", state: "not-connected" }],
  });
  fake.servers.mockResolvedValue([{ id: "mcp", name: "Local tools" }]);
  fake.summary.mockResolvedValue({ needingReconnection: 1 });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  delete window.ardurbotDesktop;
  vi.unstubAllGlobals();
});

async function mount(extra: Partial<ComponentProps<typeof Composer>> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const input = useRef<HTMLInputElement>(null);
    const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
    const [notice, setNotice] = useState<string | null>(null);
    return (
      <Composer
        running={false}
        pendingAttachments={attachments}
        attachmentNotice={notice}
        sendError={null}
        runError={null}
        runErrorId={null}
        onRunErrorPresented={vi.fn()}
        onDismissError={vi.fn()}
        sending={false}
        fileInputRef={input}
        onAttachmentPick={(files) => {
          const result = prepareComposerAttachments(
            attachments.length,
            Array.from(files ?? []),
            "bot",
          );
          setAttachments([...attachments, ...result.attachments]);
          setNotice(result.limitHit ? "Up to 4 files, 10 MB each" : null);
        }}
        onRemoveAttachment={(removed) =>
          setAttachments(attachments.filter((item) => item.id !== removed.id))
        }
        onSend={fake.send}
        onStop={fake.stop}
        onComposerError={setNotice}
        onManage={fake.manage}
        onRoutine={fake.routine}
        onSlashAction={fake.action}
        onSlashOpen={fake.open}
        skills={[{ id: "skill", name: "Daily review", description: "Review changes" }]}
        {...extra}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
}
function button(label: string): HTMLButtonElement {
  const target = [...document.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  if (!target) throw new Error(`Missing button: ${label}`);
  return target;
}
async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
    await vi.dynamicImportSettled();
  });
}
async function key(target: Element, value: string, options: KeyboardEventInit = {}) {
  await act(async () =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options }),
    ),
  );
}
async function type(value: string) {
  const input = document.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.dynamicImportSettled();
  });
}
async function openMenu() {
  await click(button("Add files or photos"));
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
}
function menuItem(text: string): HTMLElement {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.startsWith(text),
  );
  if (!item) throw new Error(`Missing menu item: ${text}`);
  return item;
}

describe("composer controls", () => {
  it.each(["streamable_http", "host-cli"])(
    "opens Manage for a %s connection needing sign-in",
    async (transport) => {
      fake.integrations.mockResolvedValue({
        catalog: [{ id: "reports", name: "Reports", authKind: "oauth" }],
        connections: [
          { id: "connection", catalogId: "reports", state: "needs-sign-in", transport },
        ],
      });
      await mount();
      await openMenu();
      await click(menuItem("Integrations"));
      await click(menuItem("Reports"));
      expect(fake.manage).toHaveBeenCalledExactlyOnceWith("connection");
    },
  );
  it("shows the exact menu order and hides folders on the web", async () => {
    await mount();
    await openMenu();
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent),
    ).toEqual([
      "Add files or photosCtrl+U",
      "Slash commands",
      "Integrations(1 need reconnection)",
      "Plugins",
    ]);
    await click(menuItem("Integrations"));
    await click(menuItem("Reports"));
    expect(fake.manage).toHaveBeenCalledWith("connection");
  });
  it.each(["darwin", "win32"])(
    "opens the existing input with the platform upload shortcut (%s)",
    async (platform) => {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: platform === "darwin" ? "MacIntel" : "Win32",
      });
      await mount();
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      const picked = vi.spyOn(input, "click").mockImplementation(() => undefined);
      await key(document.body, "u", platform === "darwin" ? { metaKey: true } : { ctrlKey: true });
      expect(picked).toHaveBeenCalledOnce();
    },
  );
  it("pastes images through the shared attachment gate and shows the limit only on the fifth", async () => {
    await mount();
    for (let index = 0; index < 5; index++) {
      await act(async () => {
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", {
          value: {
            files: [new File(["image"], `photo-${index}.png`, { type: "image/png" })],
            getData: () => "",
          },
        });
        document.querySelector("textarea")!.dispatchEvent(event);
      });
      if (index < 4) expect(document.body.textContent).not.toContain("Up to 4 files, 10 MB each");
    }
    expect(document.querySelectorAll('button[aria-label^="Remove photo-"]')).toHaveLength(4);
    expect(document.body.textContent).toContain("Up to 4 files, 10 MB each");
    await click(button("Remove photo-0.png"));
    expect(document.querySelectorAll('button[aria-label^="Remove photo-"]')).toHaveLength(3);
  });
  it.each([true, false, undefined])(
    "only offers folders when API policy confirms host execution (%s)",
    async (runsOnHost) => {
      const addRoot = vi.fn().mockResolvedValue("/fixture/reports");
      window.ardurbotDesktop = { platform: "darwin", host: { addRoot } } as unknown as NonNullable<
        Window["ardurbotDesktop"]
      >;
      await mount({ runsOnHost });
      await openMenu();
      expect(document.body.textContent?.includes("Add folder")).toBe(runsOnHost === true);
      if (runsOnHost) {
        await click(menuItem("Add folder"));
        expect(addRoot).toHaveBeenCalledOnce();
        expect(document.querySelector('[data-mention-kind="folder"]')?.textContent).toContain(
          "reports",
        );
      } else {
        expect(addRoot).not.toHaveBeenCalled();
      }
    },
  );
  it("sets the selected skill chip from Plugins", async () => {
    await mount();
    await openMenu();
    await click(menuItem("Plugins"));
    await click(menuItem("Daily review"));
    expect(document.querySelector('[data-testid="skill-chip"]')?.textContent).toContain(
      "Daily review",
    );
    await click(button("Send"));
    expect(fake.send).toHaveBeenCalledWith("/Daily review", []);
  });
  it("refreshes connector status from the same Settings query and inserts its chip", async () => {
    await mount();
    await openMenu();
    expect(fake.summary).toHaveBeenCalled();
    expect(menuItem("Integrations").textContent).toContain("1 need reconnection");
    fake.summary.mockResolvedValue({ needingReconnection: 0 });
    fake.integrations.mockResolvedValue({
      catalog: [{ id: "reports", name: "Reports" }],
      connections: [{ id: "connection", catalogId: "reports", state: "connected" }],
    });
    await act(async () => {
      await refreshIntegrationCatalog();
    });
    expect(menuItem("Integrations").textContent).toBe("Integrations");
    await click(menuItem("Integrations"));
    await click(menuItem("Reports"));
    await click(button("Send"));
    expect(fake.send).toHaveBeenCalledWith("@Reports", [
      { kind: "mcp", id: "connection", name: "Reports" },
    ]);
  });
  it("opens the same slash picker from the menu and textbox, filters, navigates and escapes", async () => {
    await mount();
    await openMenu();
    await click(menuItem("Slash commands"));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="slash-picker"]')).not.toBeNull(),
    );
    expect(document.body.textContent).toContain("/new");
    const textarea = document.querySelector("textarea")!;
    await vi.waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(document.getElementById(textarea.getAttribute("aria-controls")!)).not.toBeNull();
    expect(document.getElementById(textarea.getAttribute("aria-activedescendant")!)).not.toBeNull();
    expect(document.body.textContent).not.toContain("/compare");
    await key(document.querySelector("textarea")!, "Escape");
    expect(document.querySelector('[data-testid="slash-picker"]')).toBeNull();
    await type("/review");
    expect(document.body.textContent).toContain("/Daily review");
    expect(document.body.textContent).not.toContain("/stop");
    await key(document.querySelector("textarea")!, "Enter");
    expect(document.querySelector('[data-testid="skill-chip"]')).not.toBeNull();
    await click(button("Remove skill Daily review"));
    await type("/");
    await key(document.querySelector("textarea")!, "ArrowDown");
    await key(document.querySelector("textarea")!, "Enter");
    expect(fake.action).toHaveBeenCalledWith("stop", "");
  });
  it("keeps a /remember draft after a failed command", async () => {
    await mount();
    fake.action.mockResolvedValueOnce(false);
    await type("/remember Keep citations");
    await key(document.querySelector("textarea")!, "Enter");
    expect(fake.action).toHaveBeenCalledWith("remember", "Keep citations");
    expect(document.querySelector("textarea")!.value).toBe("/remember Keep citations");
  });
  it("uses menu arrow navigation and restores focus on Escape", async () => {
    await mount();
    await openMenu();
    const first = menuItem("Add files or photos");
    first.focus();
    await key(first, "ArrowDown");
    expect(document.activeElement?.textContent).toBe("Slash commands");
    await key(document.activeElement!, "Escape");
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    expect(document.activeElement).toBe(button("Add files or photos"));
  });
  it("offers Compare with… from the menu only for a one-to-one draft", async () => {
    const floating = () =>
      [...document.querySelectorAll("button")].filter(
        (item) => item.textContent === "Compare with…",
      );
    await mount({ comparisonBotId: "bot" });
    expect(floating()).toHaveLength(0);
    await openMenu();
    expect(document.body.textContent).not.toContain("Compare with…");
    const first = menuItem("Add files or photos");
    first.focus();
    await key(first, "Escape");
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());

    await type("Explain why sources matter");
    await openMenu();
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent).slice(1, 3),
    ).toEqual(["Slash commands", "Compare with…"]);
    await click(menuItem("Compare with…"));
    await vi.waitFor(() =>
      expect(
        document.querySelector('[role="dialog"][aria-label="Compare with…"]')?.textContent,
      ).toBe("bot: Explain why sources matter"),
    );
    expect(floating()).toHaveLength(0);
  });
  it("keeps Compare with… out of a draft that cannot be compared", async () => {
    await mount();
    await type("Explain why sources matter");
    await openMenu();
    expect(document.body.textContent).not.toContain("Compare with…");
  });
  it("shows the chip row only while a chip is selected", async () => {
    await mount();
    expect(document.querySelector('[data-testid="composer-chips"]')).toBeNull();
    await openMenu();
    await click(menuItem("Plugins"));
    await click(menuItem("Daily review"));
    expect(document.querySelector('[data-testid="composer-chips"]')?.textContent).toContain(
      "Daily review",
    );
    await click(button("Remove skill Daily review"));
    expect(document.querySelector('[data-testid="composer-chips"]')).toBeNull();
  });
  it("keeps the keyboard highlight when a parked cursor ends up over an option", async () => {
    await mount({
      mentionTargets: [
        { kind: "bot", id: "researcher", name: "Researcher" },
        { kind: "bot", id: "writer", name: "Research Writer" },
      ],
    });
    await type("@Res");
    const options = () => [
      ...document.querySelectorAll('[data-testid="mention-picker"] [role="option"]'),
    ];
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    // Removing a chip collapses the chip row, which can open the picker under a cursor
    // that never moved. That boundary mouseover must not steal the keyboard highlight.
    await act(async () => {
      options()[1]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    await key(document.querySelector("textarea")!, "Tab");
    expect(document.querySelector('[data-testid="mention-chip"]')?.textContent).toContain(
      "Researcher",
    );
    // Actually moving the pointer onto the second option still highlights it.
    await type("@Res");
    await act(async () => {
      options()[1]?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    await key(document.querySelector("textarea")!, "Tab");
    expect(
      [...document.querySelectorAll('[data-testid="mention-chip"] button')].map((chip) =>
        chip.getAttribute("aria-label"),
      ),
    ).toEqual(["Remove mention Researcher", "Remove mention Research Writer"]);
  });
  it("has a reduced-motion rule for menu and drag animations", () => {
    const css = readFileSync(path.join(import.meta.dirname, "composer.css"), "utf8");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("animation: none");
    expect(css).toContain("transition: none");
    expect(css).toContain("opacity, transform");
  });
});

describe("group composer recipients", () => {
  const members = [
    { botId: "alpha", name: "Alpha" },
    { botId: "beta", name: "Beta" },
  ];
  const groupRecipients = {
    members,
    groupRouting: { coordinatorBotId: null, defaultBotId: "beta" },
  };

  it("shows the single unaddressed responder before sending, but no idle chrome", async () => {
    const host = await mount({ groupRecipients });
    expect(host.querySelector('[data-testid="composer-recipients"]')).toBeNull();
    await type("Each member, reply with your model.");
    expect(host.querySelector('[data-testid="composer-recipients"]')?.textContent).toBe("To Beta");
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("updates the preview for one, two and everyone mentions without sending", async () => {
    const host = await mount({ groupRecipients });
    for (const [text, expected] of [
      ["@Alpha reply", "To Alpha"],
      ["@Alpha @Beta reply", "To Alpha, Beta"],
      ["@everyone reply", "To Alpha, Beta"],
      ["Each member, reply", "To Beta"],
    ]) {
      await type(text!);
      expect(host.querySelector('[data-testid="composer-recipients"]')?.textContent).toBe(expected);
    }
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("shows the coordinator for an unaddressed request", async () => {
    const host = await mount({
      groupRecipients: {
        members,
        groupRouting: { coordinatorBotId: "alpha", defaultBotId: "alpha" },
      },
    });
    await type("Status?");
    expect(host.querySelector('[data-testid="composer-recipients"]')?.textContent).toBe("To Alpha");
  });
});

it("shows queued names from saved room runs even with an empty draft", async () => {
  const members = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"].map((name) => ({
    name,
    botId: name,
  }));
  const host = await mount({
    groupRecipients: {
      members,
      groupRouting: { coordinatorBotId: null, defaultBotId: "Alpha" },
      activeRuns: members.map((m, index) => ({
        botId: m.botId,
        status: index < 4 ? "running" : "queued",
      })),
    },
  });
  expect(host.querySelector('[data-testid="composer-recipients"]')).toBeNull();
  expect(host.querySelector('[data-testid="composer-queued"]')?.textContent).toBe(
    "Queued: Epsilon, Zeta",
  );
  expect(fake.send).not.toHaveBeenCalled();
});
