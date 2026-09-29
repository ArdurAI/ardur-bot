import type { ComputerStatus } from "@ardurbot/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

import { TakeControlButton } from "./take-control-button";

const computer = (busyBotName: string | null) => ({ busyBotName }) as ComputerStatus;

it.each([
  ["hides Take control while a bot run is working", computer("Chief"), "running", false],
  [
    "offers Take control when the run asks for the user",
    computer("Chief"),
    "waiting_takeover",
    true,
  ],
  ["offers Take control when no bot is working", computer(null), null, true],
] as const)("%s", (_title, status, runStatus, offered) => {
  const html = renderToStaticMarkup(
    <TakeControlButton
      computer={status}
      runStatus={runStatus}
      taking={false}
      onTakeControl={() => undefined}
    />,
  );
  expect(html.includes("Take control")).toBe(offered);
});
