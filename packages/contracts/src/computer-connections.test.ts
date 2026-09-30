import { describe, expect, it } from "vitest";
import {
  COMPUTER_KINDS,
  COMPUTER_STATES,
  computerCapabilities,
  computerKindFacts,
  computerRuntimeSummary,
  interruptedComputerUpdate,
  recommendedContainer,
} from "./computer-connections.js";
import type { ComputerUpdate } from "./domain.js";
import { ComputerStatusSchema, CreateBotInput } from "./domain.js";
import { SandboxKind } from "./ids.js";

describe("computer execution facts", () => {
  it("matches interrupted updates to the actual computer, including shared bots", () => {
    const update: ComputerUpdate = {
      id: "update",
      computerId: "team-computer",
      botId: "other-bot",
      name: "Builder",
      mode: "team",
      status: "interrupted",
      stage: "saving",
      action: "update",
    };
    expect(interruptedComputerUpdate({ botId: "bot", computerId: "team-computer" }, [update])).toBe(
      update,
    );
    expect(
      interruptedComputerUpdate({ botId: "other-bot", computerId: "different" }, [update]),
    ).toBeUndefined();
    expect(
      interruptedComputerUpdate({ botId: "bot", computerId: "team-computer" }, [
        { ...update, status: "running" },
      ]),
    ).toBeUndefined();
  });
  it("covers every computer state with an honest phrase", () => {
    expect(Object.keys(COMPUTER_STATES).sort()).toEqual(
      [...ComputerStatusSchema.shape.state.options].sort(),
    );
    expect(
      computerRuntimeSummary({ kind: "desktop", mode: "team", state: "suspending" }),
    ).toMatchObject({ location: "This computer", stateLabel: "Paused for an update" });
  });
  it("covers every supported kind in one table, without offering a VM", () => {
    expect(Object.keys(COMPUTER_KINDS).sort()).toEqual([...SandboxKind.options].sort());
    expect(computerKindFacts("vm")).toBeNull();
  });
  it.each(Object.keys(COMPUTER_KINDS))(
    "describes the %s boundary independently of sharing",
    (kind) => {
      const facts = computerKindFacts(kind)!;
      const status = {
        kind: SandboxKind.parse(kind),
        mode: "team" as const,
        state: "stopped" as const,
      };
      const team = computerRuntimeSummary(status)!;
      const dedicated = computerRuntimeSummary(status, "dedicated")!;
      expect(team.boundary).toBe(facts.boundary);
      expect(dedicated.isolated).toBe(facts.isolated);
      expect(team.scope).toBe("team");
      expect(team.sharingWarning).toBe("Bots share files and installed tools");
      expect(dedicated.scope).toBe("bot");
      expect(dedicated.sharingWarning).toBeNull();
      expect(dedicated.sharing).toBe("Only this bot");
    },
  );
  it.each(["desktop", "ssh", "fake"])("never calls %s isolated, even when dedicated", (kind) => {
    expect(computerKindFacts(kind)?.isolated).toBe(false);
  });
  it.each(["unknown", "__proto__", "constructor"])("fails closed for %s", (kind) => {
    expect(computerKindFacts(kind)).toBeNull();
    expect(computerCapabilities(kind)).toEqual({ graphical: false, interactiveTerminal: false });
  });
  it("recommends a configured container, never a host, SSH or unqualified VM", () => {
    expect(recommendedContainer("docker", [])).toEqual({ connectionId: null });
    expect(
      recommendedContainer("desktop", [{ id: "remote", settings: { engine: "ssh" } }]),
    ).toBeNull();
    expect(
      recommendedContainer("desktop", [{ id: "engine", settings: { engine: "podman" } }]),
    ).toEqual({ connectionId: "engine" });
    expect(recommendedContainer("vm", [])).toBeNull();
  });
  it("retains legacy creation defaults and carries explicit isolated-work intent", () => {
    expect(CreateBotInput.parse({ name: "Bot" }).computerMode).toBe("team");
    expect(
      CreateBotInput.parse({ name: "Bot", isolatedComputer: { connectionId: null } })
        .isolatedComputer,
    ).toEqual({ connectionId: null });
  });
});
