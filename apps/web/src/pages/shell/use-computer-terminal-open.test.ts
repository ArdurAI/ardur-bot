import { describe, expect, it, vi } from "vitest";
import { useComputerTerminalOpen } from "./use-computer-terminal-open";

describe("useComputerTerminalOpen", () => {
  it("opens computer and clears workspace expansion", () => {
    const setComputerOpen = vi.fn();
    const setWorkspaceExpanded = vi.fn();
    const onOpen = useComputerTerminalOpen(setComputerOpen, setWorkspaceExpanded);
    onOpen();
    expect(setComputerOpen).toHaveBeenCalledWith(true);
    expect(setWorkspaceExpanded).toHaveBeenCalledWith(false);
  });
});
