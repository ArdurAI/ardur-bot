// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.mocked(rpc.board.snapshot).mockResolvedValue({
    items: [],
    readyIds: [],
    blockedIds: [],
    workspaces: [],
  } as any);
});

import { rpc } from "../lib/rpc";
import { ScratchpadSection } from "./ScratchpadSection";

vi.mock("@lingui/react/macro", () => {
  const translate = (parts: TemplateStringsArray) => parts.join("");
  return {
    Trans: ({ children }: { children: any }) => children,
    useLingui: () => ({ t: translate }),
    t: translate,
  };
});

vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: any) => <button {...props} />,
  Input: (props: any) => <input {...props} />,
  Checkbox: ({ onCheckedChange, ...props }: any) => (
    <input type="checkbox" onChange={(e) => onCheckedChange?.(e.target.checked)} {...props} />
  ),
  NativeSelect: (props: any) => <select {...props} />,
  Textarea: (props: any) => <textarea {...props} />,
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div role="dialog">{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));

vi.mock("../lib/rpc", () => ({
  rpc: {
    scratchpad: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      linkBoardItems: vi.fn(),
    },
    board: {
      view: vi.fn(),
      snapshot: vi.fn(),
      create: vi.fn(),
    },
  },
}));

describe("ScratchpadSection", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.resetAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const text = (node: Element) => node.textContent || "";

  it("lists only allowed boards, searches, and multi-select adds items", async () => {
    vi.mocked(rpc.scratchpad.list).mockResolvedValue([
      { id: "1", title: "Free text", status: "open", botId: "bot1", createdAt: "", updatedAt: "" },
      {
        id: "2",
        title: "Linked",
        status: "open",
        botId: "bot1",
        boardWorkspaceId: "ws1",
        boardItemId: "item1",
        createdAt: "",
        updatedAt: "",
      },
    ] as any);
    vi.mocked(rpc.board.view).mockResolvedValue({
      bots: [{ id: "bot1", name: "Bot" }],
      workspaces: [
        {
          id: "ws1",
          name: "Allowed Board",
          enabled: true,
          allowAllBots: false,
          allowedBotIds: ["bot1"],
        },
        {
          id: "ws2",
          name: "Denied Board",
          enabled: true,
          allowAllBots: false,
          allowedBotIds: ["other"],
        },
        {
          id: "ws3",
          name: "Disabled Board",
          enabled: false,
          allowAllBots: true,
          allowedBotIds: [],
        },
      ],
    } as any);

    vi.mocked(rpc.board.snapshot).mockResolvedValue({
      items: [],
      readyIds: [],
      blockedIds: [],
      workspaces: [],
    } as any);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <ScratchpadSection botId="bot1" />
        </MemoryRouter>,
      );
      await new Promise((r) => setTimeout(r, 0));
    });

    const btns = Array.from(document.querySelectorAll("button"));
    const addFromBoardBtn = btns.find((b) => text(b) === "Add from board");
    if (!addFromBoardBtn) console.log(document.body.innerHTML);
    expect(addFromBoardBtn).toBeTruthy();

    vi.mocked(rpc.board.snapshot).mockResolvedValue({
      items: [
        { id: "item1", title: "Already linked", status: "open", type: "task" },
        { id: "item2", title: "To link", status: "open", type: "task" },
      ],
      readyIds: [],
      blockedIds: [],
      workspaces: [],
    } as any);

    await act(async () => {
      addFromBoardBtn!.click();
    });

    // Check boards in the picker
    const select = document.querySelector("select");
    expect(select).toBeTruthy();
    const options = Array.from(select!.querySelectorAll("option"));
    expect(options.map((o) => text(o))).toEqual(["Allowed Board"]);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 250)); // wait for debounce
    });

    const labels = Array.from(document.querySelectorAll("label"));
    console.log(
      "LABELS:",
      labels.map((l) => text(l)),
    );
    expect(labels.some((l) => text(l).includes("Already linked"))).toBe(true);

    const checkboxes = Array.from(
      document.querySelectorAll("input[type=checkbox]"),
    ) as HTMLInputElement[];
    const item1Checkbox = checkboxes.find((c) =>
      c.closest("label")?.textContent?.includes("Already linked"),
    );
    expect(item1Checkbox?.disabled).toBe(true);

    const item2Checkbox = checkboxes.find((c) =>
      c.closest("label")?.textContent?.includes("To link"),
    );
    await act(async () => {
      item2Checkbox!.click();
    });

    vi.mocked(rpc.scratchpad.linkBoardItems).mockResolvedValue([] as any);

    const dialogBtns = Array.from(
      document.querySelector("[role=dialog]")!.querySelectorAll("button"),
    );
    const dialogAdd = dialogBtns.find((b) => text(b) === "Add");

    await act(async () => {
      dialogAdd!.click();
    });

    expect(rpc.scratchpad.linkBoardItems).toHaveBeenCalledWith({
      botId: "bot1",
      boardWorkspaceId: "ws1",
      boardItemIds: ["item2"],
    });
  });

  it("New work item creates on chosen board and links it", async () => {
    vi.mocked(rpc.scratchpad.list).mockResolvedValue([]);
    vi.mocked(rpc.board.view).mockResolvedValue({
      bots: [{ id: "bot1", name: "Bot" }],
      workspaces: [
        { id: "ws1", name: "Allowed Board", enabled: true, allowAllBots: true, allowedBotIds: [] },
      ],
    } as any);

    vi.mocked(rpc.board.snapshot).mockResolvedValue({
      items: [],
      readyIds: [],
      blockedIds: [],
      workspaces: [],
    } as any);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <ScratchpadSection botId="bot1" />
        </MemoryRouter>,
      );
      await new Promise((r) => setTimeout(r, 0));
    });

    const btns = Array.from(document.querySelectorAll("button"));
    const newWorkItemBtn = btns.find((b) => text(b) === "New work item");

    await act(async () => {
      newWorkItemBtn!.click();
    });

    const dialog = document.querySelector("[role=dialog]");
    expect(dialog).toBeTruthy();

    const titleInput = dialog!.querySelector("input[name=title]") as HTMLInputElement;
    await act(async () => {
      titleInput.value = "New ticket";
      titleInput.dispatchEvent(new Event("change", { bubbles: true }));
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    vi.mocked(rpc.board.create).mockResolvedValue({ id: "new-item1" } as any);
    vi.mocked(rpc.scratchpad.linkBoardItems).mockResolvedValue([] as any);

    const dialogBtns = Array.from(dialog!.querySelectorAll("button"));
    const submitBtn = dialogBtns.find((b) => text(b) === "New item" || text(b) === "Save");

    await act(async () => {
      submitBtn!.click();
    });

    expect(rpc.board.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        title: "New ticket",
      }),
    );
    expect(rpc.scratchpad.linkBoardItems).toHaveBeenCalledWith({
      botId: "bot1",
      boardWorkspaceId: "ws1",
      boardItemIds: ["new-item1"],
    });
  });
});
