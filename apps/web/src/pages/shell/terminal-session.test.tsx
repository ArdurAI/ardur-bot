// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ terminal: vi.fn(), ticket: vi.fn(), close: vi.fn() }));
vi.mock("@ardurbot/ui-web/terminal", () => ({ default: fake.terminal }));
vi.mock("../../lib/rpc", () => ({ rpc: { terminal: { ticket: fake.ticket, close: fake.close } } }));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));

import ComputerTerminalSession from "./terminal-session";

it.each([undefined, "computer"] as const)(
  "binds the shared terminal to its bot, computer and workspace=%s",
  async (workspace) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    fake.terminal.mockReturnValue(null);
    const host = document.createElement("div"),
      root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <ComputerTerminalSession botId="bot" computerId="computer" workspace={workspace} />,
        ),
      );
      const props = fake.terminal.mock.calls[0]![0];
      await props.ticket("session");
      await props.close("session");
      expect(fake.ticket).toHaveBeenCalledWith({
        botId: "bot",
        computerId: "computer",
        workspace,
        sessionId: "session",
      });
      expect(fake.close).toHaveBeenCalledWith({
        botId: "bot",
        computerId: "computer",
        sessionId: "session",
      });
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
