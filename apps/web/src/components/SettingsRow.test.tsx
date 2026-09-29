// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { changeInput, renderSettings } from "../test/settings-ui";
import {
  matchesSetting,
  SettingsGroup,
  SettingsRow,
  SettingsSearchProvider,
  useSettingsSearch,
} from "./SettingsRow";

it("filters registered row labels without unmounting their controls", async () => {
  function Page() {
    const search = useSettingsSearch();
    return (
      <>
        <input value={search.query} onChange={(e) => search.setQuery(e.target.value)} />
        <SettingsSearchProvider {...search} sectionLabel="General">
          <SettingsRow label="Chat font">
            <button type="button">Sans</button>
          </SettingsRow>
          <SettingsRow label="Motion">
            <button type="button">System</button>
          </SettingsRow>
        </SettingsSearchProvider>
        <output>{String(search.rowMatch)}</output>
      </>
    );
  }
  const { container } = await renderSettings(<Page />);
  const input = container.querySelector("input")!;
  await changeInput(input, "  CHAT FONT ");
  expect(container.querySelector<HTMLElement>('[data-settings-row="Chat font"]')?.hidden).toBe(
    false,
  );
  expect(container.querySelector<HTMLElement>('[data-settings-row="Motion"]')?.hidden).toBe(true);
  expect(container.querySelector("output")?.textContent).toBe("true");
  await changeInput(input, "General");
  expect(container.querySelectorAll("fieldset[hidden]")).toHaveLength(0);
  expect(matchesSetting("Chat font", "unknown")).toBe(false);
});

it("keeps content inside its row and renders SettingsGroup heading", async () => {
  const { container } = await renderSettings(
    <SettingsGroup label="Test Group">
      <SettingsRow label="Row 1" content={<div>Row 1 content</div>}>
        <button type="button">Action</button>
      </SettingsRow>
    </SettingsGroup>,
  );

  const group = container.querySelector("[data-settings-group]");
  expect(group).not.toBeNull();
  expect(group?.querySelector("h3")?.textContent).toBe("Test Group");

  const row = container.querySelector('[data-settings-row="Row 1"]');
  expect(row?.querySelector(".pb-4")?.textContent).toContain("Row 1 content");
});

it("hides only the settings overlay's fully-filtered groups, never row-less cards", () => {
  // The stylesheet rule that collapses empty groups exists for the settings overlay's
  // search. Applied to the panel cards (Profile, Model, …), which hold no searchable
  // rows, it must not hide them.
  const css = readFileSync(path.join(import.meta.dirname, "../styles.css"), "utf8");
  const rules = css.match(/[^{}]*\[data-settings-group\][^{}]*\{[^}]*\}/g) ?? [];
  expect(rules.length).toBeGreaterThan(0);
  const style = document.createElement("style");
  style.textContent = rules.join("\n");
  document.head.append(style);
  try {
    const card = document.createElement("section");
    card.setAttribute("data-settings-group", "");
    document.body.append(card);
    expect(getComputedStyle(card).display).not.toBe("none");
    card.remove();

    const overlay = document.createElement("div");
    overlay.setAttribute("data-settings-section", "general");
    const group = document.createElement("section");
    group.setAttribute("data-settings-group", "");
    const row = document.createElement("fieldset");
    row.setAttribute("data-settings-row", "Chat font");
    row.hidden = true;
    group.append(row);
    overlay.append(group);
    document.body.append(overlay);
    expect(getComputedStyle(group).display).toBe("none");
    row.hidden = false;
    expect(getComputedStyle(group).display).not.toBe("none");
    overlay.remove();
  } finally {
    style.remove();
  }
});
