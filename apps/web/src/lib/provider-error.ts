// Only messages that talk about the model itself offer "Change model"; an unrelated
// "not supported" (an image input, a tool) must not send the user to the model picker.
const MODEL_UNAVAILABLE =
  /\bmodel\b[^.\n]*\b(not supported|not available|does not exist|not found|unknown|invalid|unsupported)\b|\b(unknown|invalid|unsupported) model\b/i;

export function parseProviderError(text: string): {
  message: string;
  kind: "model-unavailable" | "other";
} {
  let message = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      if ("detail" in parsed && typeof parsed.detail === "string") {
        message = parsed.detail;
      } else if (
        "error" in parsed &&
        parsed.error &&
        typeof parsed.error === "object" &&
        "message" in parsed.error &&
        typeof parsed.error.message === "string"
      ) {
        message = parsed.error.message;
      } else if ("message" in parsed && typeof parsed.message === "string") {
        message = parsed.message;
      }
    }
  } catch {
    // Plain text and malformed JSON remain readable as received.
  }
  return {
    message,
    kind: MODEL_UNAVAILABLE.test(message) ? "model-unavailable" : "other",
  };
}
