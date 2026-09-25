// @vitest-environment jsdom

import { expect, it } from "vitest";
import { changeInput, renderSettings } from "../test/settings-ui";
import {
  matchesSetting,
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
