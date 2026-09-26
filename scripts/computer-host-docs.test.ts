import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const docs = ["README.md", "docs/self-host.md", "docs/fleet.md", "docs/desktop-release.md"];

it("never says the desktop app needs Docker", () => {
  for (const file of docs) {
    const text = read(file).replace(/\s+/g, " ");
    expect(text, file).not.toMatch(/requires Docker Desktop|\(needs Docker\)/i);
    expect(text, file).not.toMatch(/This computer[^.]*requires Docker/i);
  }
});

it("describes where bots run for each way of installing, in one place the others link to", () => {
  const selfHost = read("docs/self-host.md");
  const section = selfHost.split("\n## Where bots run\n")[1]?.split("\n## ")[0] ?? "";
  expect(section).toMatch(/installed desktop app/i);
  expect(section).toMatch(/Compose stack/i);
  expect(section).toMatch(/server/i);
  for (const file of ["README.md", "docs/fleet.md", "docs/desktop-release.md"])
    expect(read(file), file).toMatch(/self-host\.md#where-bots-run/);
});
