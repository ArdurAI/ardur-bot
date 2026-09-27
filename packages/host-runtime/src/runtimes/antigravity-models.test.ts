import { expect, it } from "vitest";
import { capturedAntigravityModels, parseAntigravityModels } from "./antigravity-models.js";

it("keeps the dated catalog and exact suffix rules", () => {
  expect(capturedAntigravityModels).toHaveLength(14);
  expect(
    capturedAntigravityModels.find((model) => model.id === "claude-sonnet-4-6")?.efforts,
  ).toEqual([]);
  expect(
    capturedAntigravityModels.find((model) => model.id === "gpt-oss-120b-medium")?.efforts,
  ).toEqual(["medium"]);
});
it.each(["bad", "id\tlabel\nid\tlabel", "id\tbad\u0000label", "\tlabel"])(
  "rejects malformed catalog %j",
  (output) => {
    expect(() => parseAntigravityModels(output)).toThrow();
  },
);
