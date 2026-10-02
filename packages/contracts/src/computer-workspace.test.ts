import { expect, it } from "vitest";
import {
  ComputerWorkspaceSaveError,
  ComputerWorkspaceSaveFailureCategorySchema,
  ComputerWorkspaceSaveFailureReasonSchema,
  computerWorkspaceSaveFailureReason,
} from "./computer-workspace.js";

it.each(ComputerWorkspaceSaveFailureReasonSchema.options)(
  "reads legacy and categorized %s details without changing the public reason",
  (reason) => {
    expect(computerWorkspaceSaveFailureReason(reason)).toBe(reason);
    for (const category of ComputerWorkspaceSaveFailureCategorySchema.options) {
      const error = new ComputerWorkspaceSaveError(reason, category);
      expect(error.detail).toBe(`${reason}:${category}`);
      expect(computerWorkspaceSaveFailureReason(error.detail)).toBe(reason);
    }
  },
);

it.each([
  undefined,
  "",
  "unknown",
  "save-failed:private-output",
  "save-failed:command-failed:extra",
])("rejects invalid save diagnostics: %s", (detail) =>
  expect(computerWorkspaceSaveFailureReason(detail)).toBeNull(),
);

it("keeps the original cause local and drops categories outside the allowlist", () => {
  const cause = new Error("private-output");
  const error = new ComputerWorkspaceSaveError("save-failed", "private-output", { cause });
  expect(error.cause).toBe(cause);
  expect(error.message).toBe("save-failed");
  expect(error.detail).toBe("save-failed");
  expect(error.engineFailureCategory).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain("private-output");
});
