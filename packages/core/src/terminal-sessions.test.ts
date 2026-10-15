import { expect, it } from "vitest";
import { addTerminalSession, removeTerminalSession } from "./terminal-sessions.js";

it("caps and selects independent opaque sessions without reidentifying survivors", () => {
  let collection = { sessions: [], activeId: "" } as ReturnType<typeof addTerminalSession>;
  for (const id of ["one", "two", "three", "four"]) collection = addTerminalSession(collection, id);
  expect(collection.activeId).toBe("four");
  expect(() => addTerminalSession(collection, "five")).toThrow();
  expect(() => addTerminalSession(collection, "one")).toThrow();
  collection = removeTerminalSession(collection, "two");
  expect(collection.sessions.map((session) => session.id)).toEqual(["one", "three", "four"]);
  expect(collection.activeId).toBe("four");
  collection = removeTerminalSession(collection, "four");
  expect(collection.activeId).toBe("one");
});
