import type { OutcomeObservation } from "../scoreboard/graders/outcome.js";
import { gradeOutcome } from "../scoreboard/graders/outcome.js";
import { contentDigest } from "../scoreboard/manifest.js";
import { getTask } from "../scoreboard/tasks/catalog.js";

export interface BlindPacket {
  id: string;
  taskId: string;
  fixtureHash: string;
  graderHash: string;
  observation: OutcomeObservation;
}
export function blindPacket(input: {
  taskId: string;
  trialId: string;
  fixtureHash: string;
  graderHash: string;
  observation: OutcomeObservation;
}): BlindPacket {
  const { expectedPin, observedPin, ...observation } = structuredClone(input.observation);
  // Graders see whether the independently observed route matches its commitment,
  // without seeing the product/runtime label or session identity.
  return {
    id: `blind-${contentDigest(input.trialId).slice(0, 24)}`,
    taskId: input.taskId,
    fixtureHash: input.fixtureHash,
    graderHash: input.graderHash,
    observation: {
      ...observation,
      expectedPin: { matchesCommitment: true },
      observedPin: { matchesCommitment: contentDigest(expectedPin) === contentDigest(observedPin) },
    },
  };
}
export function gradeBlind(
  packet: BlindPacket,
  frozen: { fixtureHash: string; graderHash: string },
) {
  if (packet.fixtureHash !== frozen.fixtureHash || packet.graderHash !== frozen.graderHash)
    throw new Error("Fixture or grader commitment changed");
  return {
    packetId: packet.id,
    ...gradeOutcome(getTask(packet.taskId), packet.observation),
    reviewerAgreement: null,
    humanRubric: "not-measured",
  };
}
