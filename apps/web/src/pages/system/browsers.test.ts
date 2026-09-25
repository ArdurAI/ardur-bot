import type { ComputerStatus } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { connectedBrowsers } from "./browsers";

it("lists only driveable Docker Chromium instances, once per computer", () => {
  const status = {
    kind: "docker",
    state: "running",
    screenAvailable: true,
    computerId: "computer",
    capabilities: { graphical: true, interactiveTerminal: true },
  } as ComputerStatus;
  const computers = [
    { name: "One", botId: "a", status },
    { name: "Shared", botId: "b", status },
    {
      name: "Host",
      botId: "c",
      status: { ...status, kind: "desktop" as const, computerId: "host" },
    },
    {
      name: "Stopped",
      botId: "d",
      status: { ...status, state: "stopped" as const, computerId: "stopped" },
    },
    {
      name: "No screen",
      botId: "e",
      status: { ...status, screenAvailable: false, computerId: "no-screen" },
    },
  ];
  expect(connectedBrowsers(computers)).toEqual([{ id: "computer", name: "One" }]);
});
