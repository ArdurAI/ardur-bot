import type { ComputerStatus, Run } from "@ardurbot/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

import { TakeControlButton } from "./take-control-button";

const computer = (busyBotName: string | null) => ({ busyBotName }) as ComputerStatus;
const run = (botId: string, status: Run["status"]) =>
  ({ id: `run-${botId}`, botId, status }) as Run;

it.each([
  [
    "hides Take control while a bot run is working",
    computer("Chief"),
    [run("chief", "running")],
    false,
  ],
  [
    "offers Take control when the run asks for the user",
    computer("Chief"),
    [run("chief", "waiting_takeover")],
    true,
  ],
  ["offers Take control when no bot is working", computer(null), [], true],
  [
    // In a group the thread's headline run can be another member's waiting takeover.
    "hides Take control while the open computer's bot works in a group",
    computer("Chief"),
    [run("writer", "waiting_takeover"), run("chief", "running")],
    false,
  ],
] as const)("%s", (_title, status, runs, offered) => {
  const html = renderToStaticMarkup(
    <TakeControlButton
      computer={status}
      runs={runs}
      botId="chief"
      taking={false}
      onTakeControl={() => undefined}
    />,
  );
  expect(html.includes("Take control")).toBe(offered);
});
