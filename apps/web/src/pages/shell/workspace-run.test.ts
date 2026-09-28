// @vitest-environment jsdom
import type { RunActivityRow } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { handleWorkspaceOpenRun, isWorkspaceDesktopLayout } from "./workspace-run";

describe("handleWorkspaceOpenRun", () => {
  const run: RunActivityRow = {
    runId: "run-1",
    botId: "bot-1",
    botName: "Bot 1",
    threadId: "thread-1",
    groupId: null,
    groupName: null,
    status: "running",
    trigger: "user",
    notificationsEnabled: false,
    promptSnippet: "Test prompt",
    updatedAt: "2026-09-28T00:00:00.000Z",
  };

  it("closes the pane when opening a conversation on phone-width layouts", () => {
    const navigate = vi.fn();
    const closePanel = vi.fn();
    handleWorkspaceOpenRun({ run, navigate, closePanel, isDesktop: false });
    expect(closePanel).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/app/bot-1");
  });

  it("keeps the pane open when opening a conversation on wide desktop layouts", () => {
    const navigate = vi.fn();
    const closePanel = vi.fn();
    handleWorkspaceOpenRun({ run, navigate, closePanel, isDesktop: true });
    expect(closePanel).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/app/bot-1");
  });

  it("navigates to group conversation when run belongs to a group", () => {
    const navigate = vi.fn();
    const closePanel = vi.fn();
    handleWorkspaceOpenRun({
      run: { ...run, groupId: "group-1" },
      navigate,
      closePanel,
      isDesktop: true,
    });
    expect(navigate).toHaveBeenCalledWith("/app/g/group-1");
  });

  it("checks the layout breakpoint using 768px media query", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(min-width: 768px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    expect(isWorkspaceDesktopLayout()).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 768px)");
  });
});
