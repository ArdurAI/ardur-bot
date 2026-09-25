// @vitest-environment jsdom
import type { ComputerStatus } from "@ardurbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const available = vi.hoisted(() => vi.fn(async () => ({ available: true })));
vi.mock("../../lib/rpc", () => ({ rpc: { terminal: { available } } }));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
}));

import { useComputerTerminal } from "./computer-terminal";

it.each(["ssh", "remote-docker", "kubernetes"])(
  "checks terminal availability from %s capabilities",
  async (kind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    available.mockClear();
    let state: ReturnType<typeof useComputerTerminal> | undefined;
    function Harness() {
      state = useComputerTerminal({
        computer: { kind, computerId: "computer" } as ComputerStatus,
        botId: "bot",
        hasControl: true,
        working: false,
        onTakeControl: async () => {},
        onStop: async () => {},
        onOpen: () => {},
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Harness />));
      if (kind === "kubernetes") {
        expect(available).not.toHaveBeenCalled();
        expect(state?.open).toBeUndefined();
      } else {
        expect(available).toHaveBeenCalledWith({ botId: "bot", computerId: "computer" });
        expect(state?.open).toBeTypeOf("function");
      }
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
