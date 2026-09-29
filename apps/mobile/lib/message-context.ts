import type { MobileMessage, MobileSnapshot } from "./api";

export function shouldRenderSpeakerContext(
  message: MobileMessage,
  members: MobileSnapshot["members"] | undefined,
): boolean {
  if (message.role !== "bot") return false;
  // A group thread has >1 members, or is explicitly a group. Mobile uses members.length > 1.
  return Array.isArray(members) && members.length > 1;
}
