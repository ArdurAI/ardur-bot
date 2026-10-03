// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "./tabs.js";

const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("renders only supported tabs and activates one through the tablist", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <WorkspaceTabs
        value="tasks"
        onChange={onChange}
        tabs={[
          { id: "tasks", label: "Tasks", content: <p>Current work</p> },
          { id: "files", label: "Files", content: <p>Bot files</p> },
        ]}
      />,
    ),
  );
  const tabs = container.querySelectorAll<HTMLElement>('[role="tab"]');
  expect(tabs).toHaveLength(2);
  expect(container.querySelector('[role="tab"][data-active]')?.textContent).toBe("Tasks");
  await act(async () => {
    tabs[0]?.focus();
    tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(document.activeElement).toBe(tabs[1]);
  await act(async () => tabs[1]?.click());
  expect(onChange.mock.calls[0]?.[0]).toBe("files");
  expect(container.textContent).not.toContain("Screen");
  const shared = [
    {
      id: "files",
      contentId: "editor",
      label: "Files",
      content: <textarea defaultValue="draft" />,
    },
    {
      id: "ide",
      contentId: "editor",
      label: "IDE",
      content: <textarea defaultValue="duplicate" />,
    },
  ];
  await act(async () =>
    root.render(<WorkspaceTabs value="files" onChange={onChange} tabs={shared} />),
  );
  const editor = container.querySelector("textarea");
  expect(container.querySelectorAll("textarea")).toHaveLength(1);
  await act(async () =>
    root.render(<WorkspaceTabs value="ide" onChange={onChange} tabs={shared} />),
  );
  expect(container.querySelector("textarea")).toBe(editor);
  expect(editor?.value).toBe("draft");
  await act(async () =>
    root.render(<WorkspaceTabs value="ide" onChange={onChange} tabs={shared.slice(1)} />),
  );
  expect(container.querySelector("textarea")).toBe(editor);
});
