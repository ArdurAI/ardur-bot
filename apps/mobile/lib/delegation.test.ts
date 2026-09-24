import { expect, it } from "vitest";
import { delegationLine } from "./delegation";

it("keeps stop requests and confirmed cancellation distinct in mobile activity", () => {
  const row = { requesterName: "Chief", actingName: "Reviewer" };
  const translate = (text: string) => text;
  expect(delegationLine({ ...row, status: "cancel-requested" }, translate)).toBe(
    "Chief → Reviewer · Stopping",
  );
  expect(delegationLine({ ...row, status: "cancelled" }, translate)).toBe(
    "Chief → Reviewer · Cancelled",
  );
  expect(delegationLine({ ...row, status: "completed" }, translate)).not.toBe(
    delegationLine({ ...row, status: "accepted" }, translate),
  );
});
