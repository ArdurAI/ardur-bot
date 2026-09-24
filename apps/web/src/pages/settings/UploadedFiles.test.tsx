// @vitest-environment jsdom

import { act } from "react";
import { expect, it, vi } from "vitest";
import { renderSettings } from "../../test/settings-ui";

const fake = vi.hoisted(() => ({ uploaded: vi.fn(), deleteUploaded: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { artifacts: fake } }));

import { UploadedFiles } from "./UploadedFiles";

it("shows size and date, requires confirmation and removes only a successfully deleted file", async () => {
  fake.uploaded.mockResolvedValue({
    items: [{ id: "file", name: "notes.txt", size: 42, createdAt: "2026-09-24T00:00:00Z" }],
    cursor: null,
  });
  fake.deleteUploaded.mockResolvedValue({ ok: true });
  const { container } = await renderSettings(<UploadedFiles />);
  expect(container.textContent).toContain("notes.txt");
  expect(container.textContent).toContain("42 bytes");
  expect(container.querySelector("time")?.dateTime).toBe("2026-09-24T00:00:00Z");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Delete notes.txt"]')!.click(),
  );
  expect(fake.deleteUploaded).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Confirm delete notes.txt"]')!.click(),
  );
  expect(fake.deleteUploaded).toHaveBeenCalledWith({ artifactId: "file" });
  expect(container.textContent).toContain("No uploaded files");
});
it("keeps a failed deletion visible for retry", async () => {
  fake.uploaded.mockResolvedValue({
    items: [{ id: "file", name: "notes.txt", size: 42, createdAt: "2026-09-24T00:00:00Z" }],
    cursor: null,
  });
  fake.deleteUploaded.mockRejectedValue(new Error("offline"));
  const { container } = await renderSettings(<UploadedFiles />);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Delete notes.txt"]')!.click(),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Confirm delete notes.txt"]')!.click(),
  );
  expect(container.textContent).toContain("notes.txt");
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
