import type { RuntimeAvailability, RuntimePin, RuntimeProblem } from "./runtime-pins.js";
import { runtimePinProblem } from "./runtime-pins.js";

export function antigravityEffortForModel(id: string): string | null | undefined {
  if (id === "claude-sonnet-4-6" || id === "claude-opus-4-6-thinking") return null;
  const suffix = /^(?:gemini-|gpt-oss-)[a-z0-9.-]+-(low|medium|high|max)$/.exec(id)?.[1];
  return suffix;
}

export function validateAntigravityPin(
  pin: RuntimePin,
  models: RuntimeAvailability["models"],
): RuntimeProblem | undefined {
  if (
    pin.runtimeKind !== "antigravity" ||
    pin.provider !== "antigravity" ||
    pin.credentialId !== "native:antigravity" ||
    !pin.modelId
  )
    return runtimePinProblem(pin, "pin-incomplete", "Choose an Antigravity model and sign-in.");
  if (!models.some((model) => model.id === pin.modelId))
    return runtimePinProblem(
      pin,
      "pin-model-unknown",
      `Antigravity did not recognise the model ${pin.modelId}. Pick a model from its list.`,
    );
  const expected = antigravityEffortForModel(pin.modelId);
  if (
    expected === undefined ||
    (pin.effort !== expected && !(expected !== null && pin.effort === null))
  )
    return runtimePinProblem(
      pin,
      "pin-effort-unsupported",
      "This effort does not match the pinned model.",
    );
  return undefined;
}
