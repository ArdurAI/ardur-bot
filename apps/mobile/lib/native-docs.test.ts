import { expect, it, vi } from "vitest";

const { openURL } = vi.hoisted(() => ({ openURL: vi.fn(async () => undefined) }));
vi.mock("react-native", () => ({ Linking: { openURL } }));
vi.mock("./appearance", () => ({}));
vi.mock("@ardurbot/ui-tokens", () => ({}));

import { openDocumentationUrl } from "./native";

it("delegates documentation to the system URL opener", async () => {
  await openDocumentationUrl("https://ardur.ai/docs/features/routines/");
  expect(openURL).toHaveBeenCalledWith("https://ardur.ai/docs/features/routines/");
});
