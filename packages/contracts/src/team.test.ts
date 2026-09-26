import { expect, it } from "vitest";
import { TeamBoardSchema } from "./team.js";

it("parses a board from a server that predates hostLabel", () => {
  expect(TeamBoardSchema.parse({ rows: [] }).hostLabel).toBeUndefined();
});
